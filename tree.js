// Turns the flat list of people (each with parentIds / spouses / siblingIds)
// into a generation-by-generation diagram: rows of cards connected by SVG
// lines, auto-arranged with no manual positioning. Re-renders from scratch
// on every data change — the tree is small enough (a family, not a census)
// that a full rebuild is simpler and safer than incremental DOM patching.

export const CARD_W = 220;
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

  // Pull married-in spouses (who may have no recorded parents) up to
  // whatever level their partner landed on, so they sit side-by-side
  // instead of floating up at the top as a false "generation 0".
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of people) {
      for (const s of p.spouses || []) {
        if (!byId.has(s.id)) continue;
        const a = memo.get(p.id);
        const b = memo.get(s.id);
        const max = Math.max(a, b);
        if (a !== max) { memo.set(p.id, max); changed = true; }
        if (b !== max) { memo.set(s.id, max); changed = true; }
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

function computePositions(rows) {
  const rowWidths = rows.map((row) => row.length * CARD_W + (row.length - 1) * H_GAP);
  const canvasWidth = Math.max(...rowWidths, CARD_W) + MARGIN * 2;
  const canvasHeight = rows.length * (CARD_H + V_GAP) + MARGIN;

  const pos = new Map();
  rows.forEach((row, level) => {
    const rowWidth = rowWidths[level];
    const startX = MARGIN + (canvasWidth - MARGIN * 2 - rowWidth) / 2;
    const y = MARGIN + level * (CARD_H + V_GAP);
    row.forEach((id, i) => {
      const x = startX + i * (CARD_W + H_GAP);
      pos.set(id, { x, y });
    });
  });

  return { pos, canvasWidth, canvasHeight };
}

function fmtYears(p) {
  if (!p.birthYear && !p.deathYear) return '';
  if (p.birthYear && p.deathYear) return `${p.birthYear} – ${p.deathYear}`;
  if (p.birthYear) return `${p.birthYear} –`;
  return `– ${p.deathYear}`;
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
  const { pos, canvasWidth, canvasHeight } = computePositions(rows);
  return { rows, pos, canvasWidth, canvasHeight };
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
  const { pos, canvasWidth, canvasHeight } = computeLayout(people);

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
    const anchorY = Math.max(...parentPts.map((pt) => pt.y)) + CARD_H;

    const childPts = children.map((c) => pos.get(c.id)).filter(Boolean);
    const barY = anchorY + V_GAP / 2;

    svg.appendChild(svgEl('line', { x1: anchorX, y1: anchorY, x2: anchorX, y2: barY, class: 'link link-descent' }));

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
      const left = a.x < b.x ? a : b;
      const right = a.x < b.x ? b : a;
      const y = left.y + CARD_H / 2;
      const cls = s.status === 'former' ? 'link link-spouse link-former' : 'link link-spouse';
      svg.appendChild(svgEl('line', { x1: left.x + CARD_W, y1: y, x2: right.x, y2: y, class: cls }));
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
      const left = a.x < b.x ? a : b;
      const right = a.x < b.x ? b : a;
      const y = left.y + CARD_H / 2;
      svg.appendChild(svgEl('line', {
        x1: left.x + CARD_W, y1: y, x2: right.x, y2: y, class: 'link link-sibling',
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

    const years = fmtYears(p);
    card.innerHTML = `
      ${p.founder ? '<div class="founder-badge">⭐ Fundador del árbol</div>' : ''}
      <div class="person-card-body">
        ${p.photoUrl ? `<img class="person-photo" src="${p.photoUrl}" alt="">` : ''}
        <div class="person-info">
          <div class="person-name">${escapeHtml(p.name)}</div>
          ${years ? `<div class="person-years">${escapeHtml(years)}</div>` : ''}
          ${p.location ? `<div class="person-location">📍 ${escapeHtml(p.location)}</div>` : ''}
        </div>
      </div>
    `;
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
