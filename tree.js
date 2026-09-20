// Turns the flat list of people (each with parentIds / spouses / siblingIds)
// into a generation-by-generation diagram: rows of cards connected by SVG
// lines, auto-arranged with no manual positioning. Re-renders from scratch
// on every data change — the tree is small enough (a family, not a census)
// that a full rebuild is simpler and safer than incremental DOM patching.

import { formatPartialDate } from './dates.js';

export const CARD_W = 220;
// Cards grow taller than this when a person has multiple locations, a long
// occupation, etc. It's only a fallback for the (rare) case a card can't be
// measured — real layout uses each card's actual measured height so the
// connector lines always meet the real edges instead of a guessed one.
export const CARD_H = 128;
const H_GAP = 48;
const V_GAP = 130;
const MARGIN = 60;

function computeLevels(people) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const memo = new Map();

  function levelOf(id, visiting) {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0; // guards against bad/circular data
    visiting.add(id);
    const p = byId.get(id);
    const parents = (p.parentIds || []).filter((pid) => byId.has(pid));
    const level = parents.length
      ? Math.max(...parents.map((pid) => levelOf(pid, visiting))) + 1
      : 0;
    visiting.delete(id);
    memo.set(id, level);
    return level;
  }

  for (const p of people) levelOf(p.id, new Set());

  // A married couple is shown side by side on one row regardless of whose
  // blood-line generation is technically deeper — that's how this family
  // wants couples read (together, as the parents of their children), not
  // split across rows. The parent-child connector below is responsible for
  // making a couple's own parents still read correctly even when this pulls
  // one of them a row or two further down than their birth generation.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of people) {
      for (const s of p.spouses || []) {
        if (!byId.has(s.id)) continue;
        const max = Math.max(memo.get(p.id), memo.get(s.id));
        if (memo.get(p.id) !== max) { memo.set(p.id, max); changed = true; }
        if (memo.get(s.id) !== max) { memo.set(s.id, max); changed = true; }
      }
    }
  }

  return memo;
}

function parentKey(p) {
  return (p.parentIds || []).slice().sort().join(',');
}

// Sorts a sibling group chronologically (as before), then — if the tree's
// founder is among them — moves them to the middle of the group instead of
// wherever their entry order landed them. The founder made this tree for
// the whole family and is meant to read as its center, not drift to one
// side as more siblings get added around them later.
function sortSiblingsCentered(members) {
  const sorted = members.slice().sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
  const founderIdx = sorted.findIndex((m) => m.founder);
  if (founderIdx === -1) return sorted;
  const [founder] = sorted.splice(founderIdx, 1);
  sorted.splice(Math.floor(sorted.length / 2), 0, founder);
  return sorted;
}

function orderRows(people, levels) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const maxLevel = Math.max(0, ...people.map((p) => levels.get(p.id)));
  const rows = [];

  const level0 = sortSiblingsCentered(people.filter((p) => levels.get(p.id) === 0));
  rows[0] = level0.map((p) => p.id);

  for (let L = 1; L <= maxLevel; L++) {
    const prevIndex = new Map((rows[L - 1] || []).map((id, i) => [id, i]));
    const peopleAtL = people.filter((p) => levels.get(p.id) === L);

    const groups = new Map();
    for (const p of peopleAtL) {
      const key = parentKey(p);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    const groupList = [...groups.entries()].map(([key, members]) => {
      const parentIds = key ? key.split(',') : [];
      const positions = parentIds.map((id) => prevIndex.get(id)).filter((v) => v !== undefined);
      const avgPos = positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length : Infinity;
      return { avgPos, members: sortSiblingsCentered(members) };
    });
    groupList.sort((a, b) => a.avgPos - b.avgPos);

    let row = groupList.flatMap((g) => g.members.map((m) => m.id));

    // Nudge spouses to sit next to each other within the row.
    for (let i = 0; i < row.length; i++) {
      const p = byId.get(row[i]);
      for (const s of p.spouses || []) {
        const j = row.indexOf(s.id);
        if (j === -1 || j === i + 1 || j === i - 1) continue;
        row.splice(j, 1);
        const newI = row.indexOf(row[i]);
        row.splice(newI + 1, 0, s.id);
      }
    }

    rows[L] = row;
  }

  return rows;
}

// Renders every card off-screen (same markup as the real ones) purely to
// read back its natural height. Layout then uses these real heights instead
// of a guessed constant, so connector lines always land on an actual card
// edge instead of floating wherever a fixed CARD_H assumed the edge to be.
function measureCardHeights(people) {
  const heights = new Map();
  if (typeof document === 'undefined') {
    for (const p of people) heights.set(p.id, CARD_H);
    return heights;
  }

  const probe = document.createElement('div');
  probe.style.position = 'fixed';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.top = '-9999px';
  probe.style.left = '-9999px';
  document.body.appendChild(probe);

  for (const p of people) {
    // Must be a <button>, same as the real card (renderTree below) — a
    // <div> with identical content renders a few pixels taller here, which
    // used to throw anchorY off just enough that connector lines landed
    // past the real card edge instead of touching it.
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'person-card' + (p.founder ? ' founder' : '');
    card.style.position = 'static';
    card.style.width = CARD_W + 'px';
    card.innerHTML = personCardInnerHtml(p);
    probe.appendChild(card);
    heights.set(p.id, Math.max(CARD_H, card.offsetHeight));
    probe.removeChild(card);
  }

  document.body.removeChild(probe);
  return heights;
}

// Splits a row into "sibling blocks": everyone who shares the exact same
// parentKey (full siblings), plus each of their spouses nudged in next to
// them. A block is the thing that gets ONE shared anchor and is centered
// on it as a whole — full siblings have to move together as one group, or
// each one individually cascading off the same shared anchor point drifts
// the group asymmetrically off-center instead of straddling it.
//
// A spouse joins the current block whenever they're the recorded spouse
// of someone already in it — even when that spouse has real blood parents
// of their own (a couple who are each other's blood-distant relatives:
// computeLevels always keeps married couples on one row). Checking that
// FIRST, before falling back to "shares the same parentKey", is what
// keeps a couple like Faustino+Basilisa together as one block instead of
// Basilisa splitting off into her own block anchored on her own distant
// parents. That distant ancestry is still handled correctly — separately,
// by the parent-child connector, which routes around the row via the
// side rail when needed.
function computeSiblingBlocks(row, byId) {
  const blocks = [];
  for (const id of row) {
    const p = byId.get(id);
    const ownKey = parentKey(p);
    const last = blocks[blocks.length - 1];
    const joinsLastAsSpouse = last && last.ids.some((mid) => (p.spouses || []).some((s) => s.id === mid));
    const sharesLastBloodKey = last && ownKey && ownKey === last.key;

    if (joinsLastAsSpouse || sharesLastBloodKey) {
      last.ids.push(id);
      if (!last.key && ownKey) last.key = ownKey;
    } else {
      blocks.push({ key: ownKey || null, ids: [id] });
    }
  }
  for (const block of blocks) {
    if (!block.key) block.key = 'synth:' + block.ids.slice().sort().join(',');
  }
  return blocks;
}

// Within one sibling block, splits into "person units": one blood sibling
// plus their own spouse riding along right after them. This is the unit
// that reserves its OWN width based on ITS OWN children/grandchildren —
// a sibling with a big family of their own needs more room than one
// without, even though both sit in the same block.
function computePersonUnits(ids, byId) {
  const units = [];
  for (const id of ids) {
    const p = byId.get(id);
    const prev = units[units.length - 1];
    const isSpouseOfPrev = prev && (p.spouses || []).some((s) => s.id === prev.bloodId);
    if (isSpouseOfPrev) prev.ids.push(id);
    else units.push({ bloodId: id, ids: [id] });
  }
  return units;
}

// Every person-unit needs at least its own card width, but if its blood
// member's own children (one level down) collectively need more room
// than that, this unit has to reserve that much space instead —
// otherwise the row below gets squeezed into a gap narrower than it
// needs and spills into a neighboring family's column. A block's total
// width is just the sum of its person-units' widths. Computed bottom-up
// (deepest level first) so each level's reservations already account for
// everything beneath it.
function computeReservedWidths(rows, byId) {
  const blocksByLevel = rows.map((row) => computeSiblingBlocks(row, byId));
  const unitsByLevel = blocksByLevel.map((blocks) => blocks.map((b) => computePersonUnits(b.ids, byId)));
  const unitWidth = new Map(); // `${level}:${bloodId}` -> width
  const blockWidth = new Map(); // `${level}:${blockIndex}` -> width

  for (let level = rows.length - 1; level >= 0; level--) {
    const childBlocks = level + 1 < rows.length ? blocksByLevel[level + 1] : [];
    blocksByLevel[level].forEach((block, bi) => {
      let total = 0;
      const units = unitsByLevel[level][bi];
      units.forEach((unit) => {
        const naturalWidth = unit.ids.length * CARD_W + (unit.ids.length - 1) * H_GAP;
        const childWidths = childBlocks
          .map((cb, cbi) => ({ cb, cbi }))
          .filter(({ cb }) => !cb.key.startsWith('synth:') && cb.key.split(',').includes(unit.bloodId))
          .map(({ cbi }) => blockWidth.get((level + 1) + ':' + cbi));
        const childrenTotal = childWidths.length
          ? childWidths.reduce((a, b) => a + b, 0) + H_GAP * (childWidths.length - 1)
          : 0;
        const width = Math.max(naturalWidth, childrenTotal);
        unitWidth.set(level + ':' + unit.bloodId, width);
        total += width;
      });
      total += H_GAP * Math.max(0, units.length - 1);
      blockWidth.set(level + ':' + bi, total);
    });
  }

  return { blocksByLevel, unitsByLevel, unitWidth, blockWidth };
}

// A real parentKey ("id1,id2") anchors to those parents' actual pixel
// center in the row already laid out above. A synthetic "synth:" key
// (root ancestors, or anyone whose own parents aren't recorded) has
// nothing to anchor to, so the block just continues the row's
// left-to-right flow instead.
function anchorXForKey(key, pos) {
  if (key.startsWith('synth:')) return null;
  const ids = key.split(',').filter((id) => pos.has(id));
  if (!ids.length) return null;
  const sum = ids.reduce((acc, id) => acc + pos.get(id).x + CARD_W / 2, 0);
  return sum / ids.length;
}

// Lays out one row by walking its sibling blocks left to right: each
// block is pulled toward the horizontal center of its own parents, given
// its full pre-reserved width, and only pushed further right if that
// would overlap the previous block. Within a block, each person-unit
// gets its own reserved chunk of that width (its cards centered within
// it), laid out left to right in turn. Because widths already account
// for descendants (see computeReservedWidths), a family that needs more
// room pushes its own neighbors apart at THIS level instead of
// overflowing into them further down the tree — which is what let one
// family's grandchildren visually spill into and merge with an unrelated
// neighboring family's line.
function layoutRowX(blocks, units, level, widths, y, pos) {
  let cursor = null;
  blocks.forEach((block, bi) => {
    const slotWidth = widths.blockWidth.get(level + ':' + bi);
    const anchorX = anchorXForKey(block.key, pos);
    const idealStart = anchorX != null ? anchorX - slotWidth / 2 : (cursor == null ? 0 : cursor + H_GAP);
    const slotStart = cursor == null ? idealStart : Math.max(idealStart, cursor + H_GAP);

    let unitCursor = slotStart;
    for (const unit of units[bi]) {
      const unitWidth = widths.unitWidth.get(level + ':' + unit.bloodId);
      const naturalWidth = unit.ids.length * CARD_W + (unit.ids.length - 1) * H_GAP;
      const cardsStart = unitCursor + (unitWidth - naturalWidth) / 2;
      unit.ids.forEach((id, j) => pos.set(id, { x: cardsStart + j * (CARD_W + H_GAP), y }));
      unitCursor += unitWidth + H_GAP;
    }

    cursor = slotStart + slotWidth;
  });
}

function computePositions(rows, heights, people) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const rowHeights = rows.map((row) => Math.max(CARD_H, ...row.map((id) => heights.get(id) ?? CARD_H)));
  const widths = computeReservedWidths(rows, byId);

  const pos = new Map();
  let y = MARGIN;
  rows.forEach((row, level) => {
    layoutRowX(widths.blocksByLevel[level], widths.unitsByLevel[level], level, widths, y, pos);
    y += rowHeights[level] + V_GAP;
  });

  // Rows are no longer independently centered (see layoutRowX above), so
  // the canvas has to be sized to whatever bounding box the tree actually
  // ended up with, then shifted so nothing sits left of the margin.
  const xs = [...pos.values()].map((pt) => pt.x);
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) + CARD_W : CARD_W;
  const shift = MARGIN - minX;
  for (const pt of pos.values()) pt.x += shift;

  const canvasWidth = (maxX - minX) + MARGIN * 2;
  const canvasHeight = y - V_GAP + MARGIN;

  return { pos, canvasWidth, canvasHeight, rowHeights };
}

function fmtYears(p) {
  const birth = formatPartialDate(p.birthDay, p.birthMonth, p.birthYear);
  const death = formatPartialDate(p.deathDay, p.deathMonth, p.deathYear);
  if (!birth && !death) return '';
  if (birth && death) return `${birth} – ${death}`;
  if (birth) return `${birth} –`;
  return `– ${death}`;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// The numeric layout only (rows + pixel positions), with no DOM — shared by
// renderTree (the interactive view) and the print paginator, so both agree
// on exactly where every card sits.
export function computeLayout(people) {
  // Levels are computed over EVERYONE, including hidden generation
  // placeholders (see personCardInnerHtml / renderTree below) — a
  // placeholder with no other details still anchors its children's blood
  // generation correctly. Rows/positions are then built from only the
  // visible people, so a placeholder never reserves a card-sized slot or
  // shows up as a blank box in the diagram.
  const levels = computeLevels(people);
  const visible = people.filter((p) => !p.hidden);
  const rows = orderRows(visible, levels);
  const heights = measureCardHeights(visible);
  const { pos, canvasWidth, canvasHeight, rowHeights } = computePositions(rows, heights, visible);
  return { rows, pos, canvasWidth, canvasHeight, rowHeights, heights };
}

function personCardInnerHtml(p) {
  const years = fmtYears(p);
  return `
    ${p.founder ? '<div class="founder-badge">⭐ Fundador del árbol</div>' : ''}
    <div class="person-card-body">
      ${p.photoUrl ? `<img class="person-photo" src="${p.photoUrl}" alt="">` : ''}
      <div class="person-info">
        <div class="person-name">${escapeHtml(p.name)}</div>
        ${years ? `<div class="person-years">${escapeHtml(years)}</div>` : ''}
        ${p.location ? `<div class="person-location">📍 ${escapeHtml(p.location)}</div>` : ''}
        ${p.deathPlace ? `<div class="person-death-place">📍 ${escapeHtml(p.deathPlace)}</div>` : ''}
        ${p.occupation ? `<div class="person-occupation">💼 ${escapeHtml(p.occupation)}</div>` : ''}
      </div>
    </div>
  `;
}

export function renderTree(container, people, { selectedId, onSelectPerson } = {}) {
  container.innerHTML = '';

  if (!people.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'Todavía no hay nadie en el árbol. Usa el botón "+ Agregar persona" para comenzar.';
    container.appendChild(empty);
    return;
  }

  const byId = new Map(people.map((p) => [p.id, p]));
  const { pos, canvasWidth, canvasHeight, heights, rows, rowHeights } = computeLayout(people);
  const cardBottom = (id) => pos.get(id).y + (heights.get(id) ?? CARD_H);
  const cardCenterY = (id) => pos.get(id).y + (heights.get(id) ?? CARD_H) / 2;

  const idToRow = new Map();
  rows.forEach((row, level) => { for (const id of row) idToRow.set(id, level); });
  // A married-in spouse can get pulled several rows down from their own
  // parents (see computeLevels). A straight vertical line from those
  // parents down to that row would cut right through whoever else happens
  // to occupy the intervening row(s) — this rail is a permanently empty
  // strip along the canvas edge (every row is centered inside canvasWidth,
  // so nothing is ever placed out here) that those connectors detour
  // through instead, so they never look like they touch an unrelated card.
  const railX = canvasWidth - MARGIN / 2;
  const rowBottom = (level) => pos.get(rows[level][0]).y + rowHeights[level];

  const wrapper = document.createElement('div');
  wrapper.className = 'tree-canvas';
  wrapper.style.width = canvasWidth + 'px';
  wrapper.style.height = canvasHeight + 'px';

  const svg = svgEl('svg', {
    width: canvasWidth,
    height: canvasHeight,
    class: 'tree-lines',
  });
  wrapper.appendChild(svg);

  // Parent -> children connectors, grouped by exact parent-set.
  const seenGroups = new Set();
  for (const p of people) {
    const key = parentKey(p);
    if (!key || seenGroups.has(key)) continue;
    seenGroups.add(key);

    const children = people.filter((c) => parentKey(c) === key);
    if (!children.length) continue;
    // A hidden generation placeholder (see personCardInnerHtml/renderTree)
    // has no card and no `pos` entry, so it's excluded here — a child whose
    // only recorded parent is one of these gets no connector line at all
    // above them, which is correct: there's nothing visible to anchor to.
    const parentIds = key.split(',').filter((id) => byId.has(id) && pos.has(id));
    if (!parentIds.length) continue;

    const parentPts = parentIds.map((id) => pos.get(id));
    const anchorX = parentPts.reduce((a, b) => a + b.x + CARD_W / 2, 0) / parentPts.length;
    const bottomY = Math.max(...parentIds.map((id) => cardBottom(id)));

    const childPts = children.map((c) => pos.get(c.id)).filter(Boolean);
    if (!childPts.length) continue;
    // Anchored off the child row itself (not the parents' row) so this
    // still lands right above the children even when they ended up two or
    // more rows down from their parents (a spouse pulled onto a much later
    // row — see computeLevels).
    const barY = Math.min(...childPts.map((pt) => pt.y)) - V_GAP / 2;

    // When the two co-parents are each other's spouse, start the drop line
    // at their marriage line instead of below their cards — anchorX already
    // sits at that line's own midpoint (the gap between the two cards), so
    // starting higher, at the marriage line itself, makes the drop read as
    // growing out of it instead of floating in the empty gap below them.
    const [parentA, parentB] = parentIds;
    const areSpouses = parentIds.length === 2
      && (byId.get(parentA).spouses || []).some((s) => s.id === parentB);
    const dropStartY = areSpouses
      ? (cardCenterY(parentA) + cardCenterY(parentB)) / 2
      : bottomY;

    const parentLevel = Math.max(...parentIds.map((id) => idToRow.get(id)));
    const childLevel = Math.min(...children.filter((c) => idToRow.has(c.id)).map((c) => idToRow.get(c.id)));

    if (childLevel > parentLevel + 1) {
      // The children's row isn't right below the parents' — route around
      // whoever sits in the row(s) between them via the side rail instead
      // of drawing straight through their cards.
      const clearY = rowBottom(parentLevel);
      svg.appendChild(svgEl('line', { x1: anchorX, y1: dropStartY, x2: anchorX, y2: clearY, class: 'link link-descent' }));
      svg.appendChild(svgEl('line', { x1: anchorX, y1: clearY, x2: railX, y2: clearY, class: 'link link-descent' }));
      svg.appendChild(svgEl('line', { x1: railX, y1: clearY, x2: railX, y2: barY, class: 'link link-descent' }));
      svg.appendChild(svgEl('line', { x1: railX, y1: barY, x2: anchorX, y2: barY, class: 'link link-descent' }));
    } else {
      svg.appendChild(svgEl('line', { x1: anchorX, y1: dropStartY, x2: anchorX, y2: barY, class: 'link link-descent' }));
    }

    const xs = childPts.map((pt) => pt.x + CARD_W / 2);
    const barLeft = Math.min(anchorX, ...xs);
    const barRight = Math.max(anchorX, ...xs);
    svg.appendChild(svgEl('line', { x1: barLeft, y1: barY, x2: barRight, y2: barY, class: 'link link-bar' }));

    for (const pt of childPts) {
      const cx = pt.x + CARD_W / 2;
      svg.appendChild(svgEl('line', { x1: cx, y1: barY, x2: cx, y2: pt.y, class: 'link link-descent' }));
    }
  }

  // Spouse connectors.
  const drawnSpousePairs = new Set();
  for (const p of people) {
    for (const s of p.spouses || []) {
      const pairKey = [p.id, s.id].sort().join('|');
      if (drawnSpousePairs.has(pairKey) || !byId.has(s.id)) continue;
      drawnSpousePairs.add(pairKey);
      const a = pos.get(p.id);
      const b = pos.get(s.id);
      if (!a || !b) continue;
      const leftId = a.x < b.x ? p.id : s.id;
      const rightId = a.x < b.x ? s.id : p.id;
      const left = pos.get(leftId);
      const right = pos.get(rightId);
      const y1 = cardCenterY(leftId);
      const y2 = cardCenterY(rightId);
      const cls = s.status === 'former' ? 'link link-spouse link-former' : 'link link-spouse';
      svg.appendChild(svgEl('line', { x1: left.x + CARD_W, y1, x2: right.x, y2, class: cls }));
    }
  }

  // Sibling-only connectors (no shared parent already drawn above).
  const drawnSiblingPairs = new Set();
  for (const p of people) {
    for (const sibId of p.siblingIds || []) {
      const pairKey = [p.id, sibId].sort().join('|');
      if (drawnSiblingPairs.has(pairKey) || !byId.has(sibId)) continue;
      drawnSiblingPairs.add(pairKey);
      const sib = byId.get(sibId);
      if (parentKey(p) && parentKey(p) === parentKey(sib)) continue; // already connected via parents
      const a = pos.get(p.id);
      const b = pos.get(sibId);
      if (!a || !b) continue;
      const leftId = a.x < b.x ? p.id : sibId;
      const rightId = a.x < b.x ? sibId : p.id;
      const left = pos.get(leftId);
      const right = pos.get(rightId);
      const y1 = cardCenterY(leftId);
      const y2 = cardCenterY(rightId);
      svg.appendChild(svgEl('line', {
        x1: left.x + CARD_W, y1, x2: right.x, y2, class: 'link link-sibling',
      }));
    }
  }

  // Cards.
  for (const p of people) {
    const at = pos.get(p.id);
    if (!at) continue;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'person-card' + (p.founder ? ' founder' : '') + (p.id === selectedId ? ' selected' : '') + (p.deathYear ? ' deceased' : '');
    card.style.left = at.x + 'px';
    card.style.top = at.y + 'px';
    card.style.width = CARD_W + 'px';
    card.style.minHeight = CARD_H + 'px';
    card.setAttribute('aria-label', p.name);
    card.innerHTML = personCardInnerHtml(p);
    card.addEventListener('click', () => onSelectPerson && onSelectPerson(p.id));
    wrapper.appendChild(card);
  }

  container.appendChild(wrapper);

  if (selectedId) {
    const card = wrapper.querySelector('.person-card.selected');
    card?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
