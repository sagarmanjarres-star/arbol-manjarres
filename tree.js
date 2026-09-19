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

function orderRows(people, levels) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const maxLevel = Math.max(0, ...people.map((p) => levels.get(p.id)));
  const rows = [];

  const level0 = people.filter((p) => levels.get(p.id) === 0);
  level0.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
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
      members.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
      return { avgPos, members };
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

function computePositions(rows, heights) {
  const rowWidths = rows.map((row) => row.length * CARD_W + (row.length - 1) * H_GAP);
  const canvasWidth = Math.max(...rowWidths, CARD_W) + MARGIN * 2;

  const rowHeights = rows.map((row) => Math.max(CARD_H, ...row.map((id) => heights.get(id) ?? CARD_H)));

  const pos = new Map();
  const rowY = [];
  let y = MARGIN;
  rows.forEach((row, level) => {
    rowY[level] = y;
    const rowWidth = rowWidths[level];
    const startX = MARGIN + (canvasWidth - MARGIN * 2 - rowWidth) / 2;
    row.forEach((id, i) => {
      const x = startX + i * (CARD_W + H_GAP);
      pos.set(id, { x, y });
    });
    y += rowHeights[level] + V_GAP;
  });
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
  const levels = computeLevels(people);
  const rows = orderRows(people, levels);
  const heights = measureCardHeights(people);
  const { pos, canvasWidth, canvasHeight, rowHeights } = computePositions(rows, heights);
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

    const parentIds = key.split(',').filter((id) => byId.has(id));
    const children = people.filter((c) => parentKey(c) === key);
    if (!parentIds.length || !children.length) continue;

    const parentPts = parentIds.map((id) => pos.get(id)).filter(Boolean);
    if (!parentPts.length) continue;
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
    const childLevel = Math.min(...children.map((c) => idToRow.get(c.id)));

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
