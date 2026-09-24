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
const TOGGLE_SIZE = 34;

// child id -> [parent ids] is already available as parentIds; this is the
// reverse map (parent id -> [child ids]), used to walk a branch downward
// when collapsing it.
function computeChildrenOf(people) {
  const map = new Map();
  for (const p of people) {
    for (const pid of p.parentIds || []) {
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid).push(p.id);
    }
  }
  return map;
}

// A collapsed branch is identified by its parentKey (e.g. a couple's joined
// id, same string parentKey() below produces for their kids) rather than by
// a single person id — that way collapsing a couple's branch collapses it
// for both of them, and a person with children from two different partners
// can collapse just one of those branches independently.
function computeCollapseHiddenIds(people, collapsedKeys) {
  const hidden = new Set();
  if (!collapsedKeys || !collapsedKeys.size) return hidden;
  const childrenOf = computeChildrenOf(people);
  for (const key of collapsedKeys) {
    const queue = people.filter((c) => parentKey(c) === key).map((c) => c.id);
    while (queue.length) {
      const id = queue.shift();
      if (hidden.has(id)) continue;
      hidden.add(id);
      for (const cid of childrenOf.get(id) || []) queue.push(cid);
    }
  }
  return hidden;
}

// Total number of people that would disappear if this key's branch were
// collapsed — shown on the toggle's "+N" badge.
function countDescendantsForKey(directChildren, childrenOf) {
  let count = 0;
  const queue = directChildren.map((c) => c.id);
  while (queue.length) {
    const id = queue.shift();
    count++;
    for (const cid of childrenOf.get(id) || []) queue.push(cid);
  }
  return count;
}

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

  // A person with no recorded parents whose children all sit further down
  // (typically the parents of someone who married into the family) belongs
  // on the row right above their earliest child — not stranded at the very
  // top of the diagram with a line that has to run past everyone else.
  const childrenOf = computeChildrenOf(people);
  changed = true;
  while (changed) {
    changed = false;
    for (const p of people) {
      if ((p.parentIds || []).some((pid) => byId.has(pid))) continue;
      const kids = childrenOf.get(p.id) || [];
      if (!kids.length) continue;
      const target = Math.min(...kids.map((k) => memo.get(k))) - 1;
      if (target > memo.get(p.id)) { memo.set(p.id, target); changed = true; }
    }
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

// How much horizontal room each person's own subtree will eventually need,
// approximated as 1 + total descendant count (a proxy for the real pixel
// width computed later in computeReservedWidths, which isn't available yet
// at ordering time). Used only to center the founder by actual visual
// weight instead of by raw sibling count.
function computeDescendantWeights(people) {
  const childrenOf = new Map();
  for (const p of people) {
    for (const pid of p.parentIds || []) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(p.id);
    }
  }
  const memo = new Map();
  function weight(id, visiting) {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 1; // guards against bad/circular data
    visiting.add(id);
    let total = 1;
    for (const cid of childrenOf.get(id) || []) total += weight(cid, visiting);
    visiting.delete(id);
    memo.set(id, total);
    return total;
  }
  for (const p of people) weight(p.id, new Set());
  return memo;
}

// The founder's own direct ancestors, one generation at a time (the founder
// made this tree for the whole family and is meant to read as its visual
// center — but "center the founder" only actually centers the diagram if
// every ancestor on the way up to the tree's root is ALSO kept centered
// among their own siblings, since it's their card position each generation
// inherits its horizontal anchor from). Includes the founder's own id.
function computeFounderPathIds(people) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const founder = people.find((p) => p.founder);
  const path = new Set();
  if (!founder) return path;
  let frontier = [founder.id];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      if (path.has(id)) continue;
      path.add(id);
      for (const pid of byId.get(id)?.parentIds || []) next.push(pid);
    }
    frontier = next;
  }
  return path;
}

// Sorts a sibling group chronologically (as before), then — if one of the
// founder's direct ancestors (or the founder themself) is among them —
// moves that person next to the point that splits the group's total
// descendant weight roughly in half, instead of wherever chronological
// order or raw sibling count landed them. See computeFounderPathIds above
// for why this has to apply at every generation, not just the founder's own.
function sortSiblingsCentered(members, weights, pathIds) {
  const sorted = members.slice().sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
  const targetIdx = pathIds ? sorted.findIndex((m) => pathIds.has(m.id)) : -1;
  if (targetIdx === -1) return sorted;
  const [target] = sorted.splice(targetIdx, 1);
  if (!sorted.length) {
    sorted.push(target);
    return sorted;
  }
  const w = sorted.map((m) => weights?.get(m.id) ?? 1);
  const total = w.reduce((a, b) => a + b, 0);
  let running = 0;
  let insertAt = sorted.length;
  for (let i = 0; i < w.length; i++) {
    running += w[i];
    if (running >= total / 2) { insertAt = i + 1; break; }
  }
  sorted.splice(insertAt, 0, target);
  return sorted;
}

function orderRows(people, levels) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const weights = computeDescendantWeights(people);
  // Reordering by ancestor path pulls each generation's cards toward their
  // own weight-balanced center, but it only helps at the founder's own
  // level — applying it a generation or two further up as well started
  // fighting the width-reservation system (a reordered ancestor's block no
  // longer lines up with where its own reserved-width children were
  // expected, leaving dead gaps in the row below). So it's scoped to
  // exactly the founder's own level.
  const founder = people.find((p) => p.founder);
  const founderLevel = founder ? levels.get(founder.id) : -1;
  const pathIds = computeFounderPathIds(people);
  const maxLevel = Math.max(0, ...people.map((p) => levels.get(p.id)));
  const rows = [];

  const level0 = sortSiblingsCentered(people.filter((p) => levels.get(p.id) === 0), weights, founderLevel === 0 ? pathIds : undefined);
  rows[0] = level0.map((p) => p.id);

  for (let L = 1; L <= maxLevel; L++) {
    const prevIndex = new Map((rows[L - 1] || []).map((id, i) => [id, i]));
    const peopleAtL = people.filter((p) => levels.get(p.id) === L);
    const levelPathIds = L === founderLevel ? pathIds : undefined;

    const groups = new Map();
    for (const p of peopleAtL) {
      const key = parentKey(p);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    const rootMembers = groups.get('') || [];
    groups.delete('');
    const groupList = [...groups.entries()].map(([key, members]) => {
      const parentIds = key ? key.split(',') : [];
      const positions = parentIds.map((id) => prevIndex.get(id)).filter((v) => v !== undefined);
      const avgPos = positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length : Infinity;
      return { avgPos, members: sortSiblingsCentered(members, weights, levelPathIds) };
    });

    // Parentless people on this row (see the lowering in computeLevels) go
    // next to the family of their child's spouse, so the line down to that
    // child is short instead of crossing the whole row.
    const groupOfPerson = new Map();
    for (const g of groupList) for (const m of g.members) groupOfPerson.set(m.id, g);
    const components = [];
    const seenRoot = new Set();
    for (const m of rootMembers) {
      if (seenRoot.has(m.id)) continue;
      const comp = [];
      const stack = [m];
      while (stack.length) {
        const cur = stack.pop();
        if (seenRoot.has(cur.id)) continue;
        seenRoot.add(cur.id);
        comp.push(cur);
        for (const s of cur.spouses || []) {
          const sp = rootMembers.find((r) => r.id === s.id);
          if (sp) stack.push(sp);
        }
      }
      components.push(comp);
    }
    for (const comp of components) {
      let avgPos = Infinity;
      outer: for (const m of comp) {
        for (const c of people) {
          if (!(c.parentIds || []).includes(m.id)) continue;
          for (const s of c.spouses || []) {
            for (const pid of byId.get(s.id)?.parentIds || []) {
              const g = groupOfPerson.get(pid);
              if (g && Number.isFinite(g.avgPos)) { avgPos = g.avgPos + 0.001; break outer; }
            }
          }
        }
      }
      groupList.push({ avgPos, members: sortSiblingsCentered(comp, weights, levelPathIds) });
    }
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
export function computeLayout(people, collapsedKeys = new Set()) {
  // Levels are computed over EVERYONE, including hidden generation
  // placeholders (see personCardInnerHtml / renderTree below) — a
  // placeholder with no other details still anchors its children's blood
  // generation correctly. Rows/positions are then built from only the
  // visible people, so a placeholder never reserves a card-sized slot or
  // shows up as a blank box in the diagram.
  const levels = computeLevels(people);
  const collapseHidden = computeCollapseHiddenIds(people, collapsedKeys);
  const visible = people.filter((p) => !p.hidden && !collapseHidden.has(p.id));
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
      </div>
    </div>
  `;
}

// Every line and toggle position the diagram draws, as plain data (no DOM),
// so renderTree just paints them and the layout can be audited offline for
// lines that cross unrelated cards or merge with another family's line.
// Lines only ever join parents to their children, or spouses to each other.
export function computeConnectors(people, layout, collapsedKeys = new Set()) {
  const { pos, canvasWidth, heights, rows, rowHeights } = layout;
  const byId = new Map(people.map((p) => [p.id, p]));
  const childrenOfMap = computeChildrenOf(people);
  const cardBottom = (id) => pos.get(id).y + (heights.get(id) ?? CARD_H);
  const cardCenterY = (id) => pos.get(id).y + (heights.get(id) ?? CARD_H) / 2;

  const idToRow = new Map();
  rows.forEach((row, level) => { for (const id of row) idToRow.set(id, level); });
  // A married-in spouse can sit several rows below their own parents (see
  // computeLevels). A straight drop would cut through whoever occupies the
  // rows in between, so those connectors detour along the empty strip at
  // the canvas edge instead.
  const railBaseX = canvasWidth - MARGIN / 2;
  const rowBottom = (level) => pos.get(rows[level][0]).y + rowHeights[level];

  const segments = [];
  const toggles = [];
  const groups = [];

  const seenGroups = new Set();
  for (const p of people) {
    const key = parentKey(p);
    if (!key || seenGroups.has(key)) continue;
    seenGroups.add(key);

    const children = people.filter((c) => parentKey(c) === key);
    if (!children.length) continue;
    // Hidden placeholders and collapsed descendants have no `pos`, so a
    // group whose parents aren't on screen, or whose children are all
    // hidden, draws nothing.
    const parentIds = key.split(',').filter((id) => byId.has(id) && pos.has(id));
    if (!parentIds.length) continue;

    const parentPts = parentIds.map((id) => pos.get(id));
    const anchorX = parentPts.reduce((a, b) => a + b.x + CARD_W / 2, 0) / parentPts.length;
    const bottomY = Math.max(...parentIds.map((id) => cardBottom(id)));

    // Co-parents who are each other's spouse: start the drop at their
    // marriage line (anchorX is already that line's midpoint).
    const [parentA, parentB] = parentIds;
    const areSpouses = parentIds.length === 2
      && (byId.get(parentA).spouses || []).some((s) => s.id === parentB);
    const dropStartY = areSpouses
      ? (cardCenterY(parentA) + cardCenterY(parentB)) / 2
      : bottomY;

    const isCollapsed = collapsedKeys.has(key);
    toggles.push({
      key,
      collapsed: isCollapsed,
      count: isCollapsed ? countDescendantsForKey(children, childrenOfMap) : 0,
      x: anchorX,
      y: dropStartY + (V_GAP - TOGGLE_SIZE) / 2,
    });
    if (isCollapsed) continue;

    const childPts = children.map((c) => pos.get(c.id)).filter(Boolean);
    if (!childPts.length) continue;
    const childXs = childPts.map((pt) => pt.x + CARD_W / 2);
    const parentLevel = Math.max(...parentIds.map((id) => idToRow.get(id)));
    const childLevel = Math.min(...children.filter((c) => idToRow.has(c.id)).map((c) => idToRow.get(c.id)));
    groups.push({
      key,
      parentIds,
      childIds: children.filter((c) => pos.has(c.id)).map((c) => c.id),
      anchorX,
      dropStartY,
      childPts,
      childXs,
      childTopY: Math.min(...childPts.map((pt) => pt.y)),
      barLeft: Math.min(anchorX, ...childXs),
      barRight: Math.max(anchorX, ...childXs),
      parentLevel,
      childLevel,
      viaRail: childLevel > parentLevel + 1,
    });
  }

  // Families whose child bars would sit at the same height and overlap
  // horizontally get their own lane inside the gap, so one family's bar
  // never runs into (and visually joins) another family's.
  const byChildRow = new Map();
  for (const g of groups) {
    const k = Math.round(g.childTopY);
    if (!byChildRow.has(k)) byChildRow.set(k, []);
    byChildRow.get(k).push(g);
  }
  for (const list of byChildRow.values()) {
    list.sort((a, b) => a.barLeft - b.barLeft);
    const laneEnds = [];
    for (const g of list) {
      let lane = laneEnds.findIndex((end) => end < g.barLeft - 12);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(g.barRight); }
      else laneEnds[lane] = g.barRight;
      g.lane = lane;
    }
    const n = laneEnds.length;
    const spacing = n > 1 ? Math.min(14, (V_GAP - 60) / (n - 1)) : 0;
    for (const g of list) g.barY = g.childTopY - V_GAP / 2 + (g.lane - (n - 1) / 2) * spacing;
  }

  let railIndex = 0;
  for (const g of groups) {
    const seg = (x1, y1, x2, y2, kind) => segments.push({ kind, group: g.key, x1, y1, x2, y2 });
    if (g.viaRail) {
      const r = railIndex++;
      const railX = railBaseX - r * 10;
      const clearY = rowBottom(g.parentLevel) + 14 + r * 8;
      seg(g.anchorX, g.dropStartY, g.anchorX, clearY, 'descent');
      seg(g.anchorX, clearY, railX, clearY, 'descent');
      seg(railX, clearY, railX, g.barY, 'descent');
      seg(railX, g.barY, g.anchorX, g.barY, 'descent');
    } else {
      seg(g.anchorX, g.dropStartY, g.anchorX, g.barY, 'descent');
    }
    seg(g.barLeft, g.barY, g.barRight, g.barY, 'bar');
    g.childPts.forEach((pt, i) => seg(g.childXs[i], g.barY, g.childXs[i], pt.y, 'descent'));
  }

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
      segments.push({
        kind: s.status === 'former' ? 'spouse-former' : 'spouse',
        group: pairKey,
        x1: pos.get(leftId).x + CARD_W, y1: cardCenterY(leftId),
        x2: pos.get(rightId).x, y2: cardCenterY(rightId),
      });
    }
  }

  return { segments, toggles, groups };
}

export function renderTree(container, people, { selectedId, onSelectPerson, collapsedKeys = new Set(), onToggleCollapse } = {}) {
  container.innerHTML = '';

  if (!people.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'Todavía no hay nadie en el árbol. Usa el botón "+ Agregar persona" para comenzar.';
    container.appendChild(empty);
    return;
  }

  const layout = computeLayout(people, collapsedKeys);
  const { pos, canvasWidth, canvasHeight } = layout;
  const { segments, toggles } = computeConnectors(people, layout, collapsedKeys);

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

  const CLASS_BY_KIND = {
    descent: 'link link-descent',
    bar: 'link link-bar',
    spouse: 'link link-spouse',
    'spouse-former': 'link link-spouse link-former',
  };
  for (const s of segments) {
    svg.appendChild(svgEl('line', { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, class: CLASS_BY_KIND[s.kind] }));
  }

  if (onToggleCollapse) {
    for (const t of toggles) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'tree-toggle' + (t.collapsed ? ' is-collapsed' : '');
      toggle.textContent = t.collapsed ? '+' + t.count : '−';
      toggle.setAttribute('aria-label', t.collapsed ? 'Mostrar descendientes' : 'Ocultar descendientes');
      toggle.style.top = t.y + 'px';
      if (t.collapsed) {
        toggle.style.left = t.x + 'px';
        toggle.style.transform = 'translateX(-50%)';
      } else {
        toggle.style.left = (t.x - TOGGLE_SIZE / 2) + 'px';
      }
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        onToggleCollapse(t.key);
      });
      wrapper.appendChild(toggle);
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
  // Centering the selected card in view is main.js's job — it pans/zooms
  // the canvas via a CSS transform (see centerViewOn), since the container
  // clips (overflow: hidden) rather than natively scrolls.
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
