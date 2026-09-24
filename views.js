// Alternative ways of looking at the same family data as the classic tree
// (tree.js): a bubble network, a radial branch view and a one-person focus
// view. They only read `people` — nothing here writes data — and d3 is
// fetched lazily the first time one of these views is opened, so the
// classic tree never depends on it.

import { formatPartialDate } from './dates.js';

let d3Promise = null;
function loadD3() {
  if (!d3Promise) d3Promise = import('https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm');
  return d3Promise;
}

const short = (n) => n.split(' ').slice(0, 2).join(' ');
const yearsOf = (p) => {
  const b = formatPartialDate(p.birthDay, p.birthMonth, p.birthYear);
  const d = formatPartialDate(p.deathDay, p.deathMonth, p.deathYear);
  if (b && d) return `${b} – ${d}`;
  if (b) return `${b} –`;
  if (d) return `– ${d}`;
  return '';
};

function buildModel(rawPeople, inLawIds) {
  const people = rawPeople.filter((p) => !p.hidden);
  const byId = new Map(people.map((p) => [p.id, p]));
  const parentsOf = (p) => (p.parentIds || []).filter((id) => byId.has(id));
  const spousesOf = (p) => (p.spouses || []).map((s) => s.id).filter((id) => byId.has(id));
  const kidsOf = new Map();
  for (const p of people) for (const pid of parentsOf(p)) {
    if (!kidsOf.has(pid)) kidsOf.set(pid, []);
    kidsOf.get(pid).push(p.id);
  }
  const kids = (id) => kidsOf.get(id) || [];

  const descMemo = new Map();
  const descCount = (id, seen = new Set()) => {
    if (seen.has(id)) return 0;
    seen.add(id);
    let t = 0;
    for (const c of kids(id)) if (!seen.has(c)) t += 1 + descCount(c, seen);
    return t;
  };
  for (const p of people) descMemo.set(p.id, descCount(p.id));

  const founder = people.find((p) => p.founder);
  const shared = new Set();
  if (founder) {
    const stack = [founder.id];
    while (stack.length) {
      const id = stack.pop();
      if (shared.has(id)) continue;
      shared.add(id);
      for (const c of kids(id)) stack.push(c);
    }
  }
  const clanOf = (id) => (inLawIds.has(id) ? 'bernal' : shared.has(id) ? 'delfin' : 'manj');
  const clanColor = (id) => `var(--c-${clanOf(id)})`;

  return { people, byId, parentsOf, spousesOf, kids, descCount: (id) => descMemo.get(id) || 0, founder, clanColor };
}

function makeInfoPanel(container, onEdit) {
  const box = document.createElement('div');
  box.className = 'alt-info';
  box.hidden = true;
  container.appendChild(box);
  return {
    show(p, withEdit) {
      const yrs = yearsOf(p);
      box.hidden = false;
      box.innerHTML = `<b></b><span></span>`;
      box.querySelector('b').textContent = p.name;
      const span = box.querySelector('span');
      const lines = [yrs || 'sin fechas'];
      if (p.location) lines.push('📍 ' + p.location);
      if (p.deathPlace) lines.push('✝︎ ' + p.deathPlace);
      span.innerHTML = lines.map((l) => {
        const d = document.createElement('div');
        d.textContent = l;
        return d.outerHTML;
      }).join('');
      if (withEdit) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-secondary alt-info-edit';
        btn.textContent = 'Editar';
        btn.onclick = () => onEdit(p.id);
        box.appendChild(btn);
      }
      box.style.pointerEvents = withEdit ? 'auto' : 'none';
    },
    hide() { box.hidden = true; },
  };
}

function addHint(container, text) {
  const h = document.createElement('div');
  h.className = 'alt-hint';
  h.textContent = text;
  container.appendChild(h);
}

// ---------- Bubble network ----------
async function renderNetwork(container, model, { selectedId, onSelectPerson }) {
  const d3 = await loadD3();
  const { people, byId, spousesOf, parentsOf, kids, descCount, clanColor } = model;
  const W = 1100, H = 700;
  const info = makeInfoPanel(container, onSelectPerson);
  addHint(container, 'Arrastra las burbujas · rueda para acercar · toca una para ver a sus parientes');

  const svg = d3.select(container).append('svg').attr('viewBox', [0, 0, W, H]).attr('class', 'alt-svg');
  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.4, 6]).on('zoom', (e) => g.attr('transform', e.transform)));

  const nodes = people.map((p) => ({ id: p.id, p, r: 6 + Math.sqrt(descCount(p.id)) * 2.4 }));
  const links = [];
  for (const p of people) {
    for (const pid of parentsOf(p)) links.push({ source: pid, target: p.id, t: 'pc' });
    for (const sid of spousesOf(p)) if (p.id < sid) links.push({ source: p.id, target: sid, t: 'sp' });
  }
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id((d) => d.id).distance((l) => (l.t === 'sp' ? 30 : 52)).strength((l) => (l.t === 'sp' ? 1 : 0.7)))
    .force('charge', d3.forceManyBody().strength(-70))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collide', d3.forceCollide((d) => d.r + 3))
    .force('x', d3.forceX(W / 2).strength(0.03))
    .force('y', d3.forceY(H / 2).strength(0.05));

  const link = g.append('g').selectAll('line').data(links).join('line')
    .attr('stroke', (l) => (l.t === 'sp' ? 'var(--gold)' : 'var(--ink-soft)'))
    .attr('stroke-width', (l) => (l.t === 'sp' ? 3.5 : 1.6)).attr('opacity', 0.7);
  const node = g.append('g').selectAll('circle').data(nodes).join('circle')
    .attr('r', (d) => d.r).attr('fill', (d) => clanColor(d.id))
    .attr('stroke', (d) => (d.p.founder ? 'var(--ink)' : 'var(--paper)')).attr('stroke-width', (d) => (d.p.founder ? 3.5 : 1.8))
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
  const showLabel = (d) => d.r > 12 || d.p.founder;
  const label = g.append('g').selectAll('text').data(nodes).join('text')
    .attr('class', 'alt-lbl').attr('text-anchor', 'middle').attr('dy', (d) => -d.r - 5)
    .text((d) => short(d.p.name)).style('display', (d) => (showLabel(d) ? 'block' : 'none'));

  let sel = null;
  const focus = (d) => {
    sel = d;
    const rel = new Set([d.id, ...parentsOf(d.p), ...spousesOf(d.p), ...kids(d.id)]);
    node.attr('opacity', (n) => (rel.has(n.id) ? 1 : 0.12));
    link.attr('opacity', (l) => (l.source.id === d.id || l.target.id === d.id ? 1 : 0.05));
    label.style('display', (n) => (rel.has(n.id) ? 'block' : 'none'));
    info.show(d.p, true);
  };
  const clear = () => {
    sel = null;
    node.attr('opacity', 1); link.attr('opacity', 0.7);
    label.style('display', (d) => (showLabel(d) ? 'block' : 'none'));
    info.hide();
  };
  node.on('click', (e, d) => { e.stopPropagation(); if (sel && sel.id === d.id) clear(); else focus(d); })
    .on('mouseenter', (e, d) => { if (!sel) info.show(d.p, false); })
    .on('mouseleave', () => { if (!sel) info.hide(); });
  svg.on('click', clear);
  sim.on('tick', () => {
    link.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y).attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
    node.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
    label.attr('x', (d) => d.x).attr('y', (d) => d.y);
  });
  if (selectedId) {
    const start = nodes.find((n) => n.id === selectedId);
    if (start) sim.on('end', () => focus(start));
  }
}

// ---------- Radial branch ----------
let radialRootId = null;

async function renderRadial(container, model, { onSelectPerson }) {
  const d3 = await loadD3();
  const { people, byId, spousesOf, parentsOf, kids, descCount, clanColor, founder } = model;
  const W = 1200, H = 900;
  const info = makeInfoPanel(container, onSelectPerson);
  addHint(container, 'Elige la rama arriba · toca una burbuja para ver sus datos');

  const roots = people.filter((p) => !parentsOf(p).length && kids(p.id).length)
    .sort((a, b) => descCount(b.id) - descCount(a.id));
  if (!roots.length) return;
  if (!radialRootId || !roots.some((r) => r.id === radialRootId)) {
    const founderRoots = new Set();
    if (founder) {
      const stack = [founder.id];
      const seen = new Set();
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        const pp = parentsOf(byId.get(id));
        if (!pp.length) founderRoots.add(id);
        pp.forEach((x) => stack.push(x));
      }
    }
    radialRootId = (roots.find((r) => founderRoots.has(r.id)) || roots[0]).id;
  }

  const bar = document.createElement('div');
  bar.className = 'alt-bar';
  const select = document.createElement('select');
  for (const r of roots) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = `${short(r.name)} (${descCount(r.id)} descendientes)`;
    select.appendChild(o);
  }
  select.value = radialRootId;
  bar.append('Rama desde: ', select);
  container.appendChild(bar);

  const svg = d3.select(container).append('svg').attr('viewBox', [-W / 2, -H / 2, W, H]).attr('class', 'alt-svg');
  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.4, 5]).on('zoom', (e) => g.attr('transform', e.transform)));

  function draw() {
    g.selectAll('*').remove();
    info.hide();
    const seen = new Set();
    const build = (id) => {
      seen.add(id);
      const p = byId.get(id);
      const n = { id, children: [] };
      const all = [...new Set([...kids(id), ...spousesOf(p).flatMap(kids)])];
      for (const k of all) if (!seen.has(k)) n.children.push(build(k));
      return n;
    };
    const rootP = byId.get(radialRootId);
    spousesOf(rootP).filter((s) => !parentsOf(byId.get(s)).length).forEach((s) => seen.add(s));
    const root = d3.hierarchy(build(radialRootId));
    const R = Math.min(W, H) / 2 - 130;
    d3.cluster().size([2 * Math.PI, R])(root);
    const pt = (a, r) => [r * Math.cos(a - Math.PI / 2), r * Math.sin(a - Math.PI / 2)];
    g.append('g').selectAll('path').data(root.links()).join('path').attr('fill', 'none')
      .attr('stroke', 'var(--ink-soft)').attr('stroke-opacity', 0.5).attr('stroke-width', 1.6)
      .attr('d', d3.linkRadial().angle((d) => d.x).radius((d) => d.y));
    for (let r = 1; r <= root.height; r++) {
      g.append('circle').attr('r', (R * r) / root.height).attr('fill', 'none').attr('stroke', 'var(--border)').attr('stroke-dasharray', '3 6');
    }
    const node = g.append('g').selectAll('g').data(root.descendants()).join('g')
      .attr('transform', (d) => { const [x, y] = pt(d.x, d.y); return `translate(${x},${y})`; });
    node.append('circle')
      .attr('r', (d) => (d.depth === 0 ? 17 : 7 + Math.min(7, Math.sqrt(descCount(d.data.id)) * 1.7)))
      .attr('fill', (d) => clanColor(d.data.id)).attr('stroke', 'var(--paper)').attr('stroke-width', 2.5)
      .style('cursor', 'pointer')
      .on('mouseenter', (e, d) => info.show(byId.get(d.data.id), false))
      .on('mouseleave', () => info.hide())
      .on('click', (e, d) => onSelectPerson(d.data.id));
    node.each(function (d) {
      spousesOf(byId.get(d.data.id)).slice(0, 2).forEach((sid, i) => {
        d3.select(this).append('circle').attr('cx', (d.depth === 0 ? 26 : 16) + i * 11).attr('cy', 0).attr('r', 5)
          .attr('fill', 'var(--paper)').attr('stroke', 'var(--gold)').attr('stroke-width', 2.5)
          .on('mouseenter', () => info.show(byId.get(sid), false)).on('mouseleave', () => info.hide());
      });
    });
    node.append('text').attr('class', 'alt-lbl').attr('dy', '0.32em')
      .attr('transform', (d) => (d.depth === 0 ? 'translate(0,32)' : `rotate(${(d.x * 180) / Math.PI - 90}) rotate(${d.x >= Math.PI ? 180 : 0})`))
      .attr('x', (d) => (d.depth === 0 ? 0 : d.x < Math.PI ? 20 : -20))
      .attr('text-anchor', (d) => (d.depth === 0 ? 'middle' : d.x < Math.PI ? 'start' : 'end'))
      .text((d) => short(byId.get(d.data.id).name));
  }
  select.onchange = () => { radialRootId = select.value; draw(); };
  draw();
}

// ---------- One-person focus ----------
let focusId = null;
export function setFocusId(id) { focusId = id; }

async function renderFocus(container, model, { selectedId, onSelectPerson, onFocusChange }) {
  const d3 = await loadD3();
  const { people, byId, spousesOf, parentsOf, kids, clanColor, founder } = model;
  const W = 1200, H = 720;
  addHint(container, 'Toca cualquier burbuja para centrarla · usa el buscador de arriba');
  if (!focusId || !byId.has(focusId)) focusId = (selectedId && byId.has(selectedId) ? selectedId : founder?.id) || people[0]?.id;
  const info = makeInfoPanel(container, onSelectPerson);
  const svg = d3.select(container).append('svg').attr('viewBox', [0, 0, W, H]).attr('class', 'alt-svg');

  function draw() {
    svg.selectAll('*').remove();
    const P = byId.get(focusId);
    if (!P) return;
    info.show(P, true);
    const parents = parentsOf(P);
    const gps = [...new Set(parents.flatMap((x) => parentsOf(byId.get(x))))];
    const sibs = [...new Set(parents.flatMap(kids))].filter((x) => x !== focusId && !spousesOf(P).includes(x));
    const ch = [...new Set([focusId, ...spousesOf(P)].flatMap(kids))];
    const gch = [...new Set(ch.flatMap(kids))];
    const half = Math.ceil(sibs.length / 2);
    const rows = { '-2': gps, '-1': parents, 0: [...sibs.slice(0, half), focusId, ...spousesOf(P), ...sibs.slice(half)], 1: ch, 2: gch };
    const Y = { '-2': 80, '-1': 215, 0: 355, 1: 500, 2: 635 };
    const R = { '-2': 24, '-1': 30, 0: 40, 1: 30, 2: 22 };
    const pos = new Map();
    for (const [lv, ids] of Object.entries(rows)) {
      const n = ids.length;
      const gap = Math.min(200, (W - 200) / Math.max(1, n));
      ids.forEach((id, i) => pos.set(`${id}@${lv}`, { x: W / 2 + (i - (n - 1) / 2) * gap, y: Y[lv], r: id === focusId ? R[lv] + 8 : R[lv] }));
    }
    const at = (id, lv) => pos.get(`${id}@${lv}`);
    const curve = (a, b) => {
      if (!a || !b) return;
      const mid = (a.y + b.y) / 2;
      svg.append('path').attr('d', `M${a.x},${a.y}C${a.x},${mid} ${b.x},${mid} ${b.x},${b.y}`)
        .attr('fill', 'none').attr('stroke', 'var(--ink-soft)').attr('stroke-width', 1.8).attr('opacity', 0.65);
    };
    for (const s of spousesOf(P)) {
      const a = at(focusId, 0), b = at(s, 0);
      svg.append('line').attr('x1', a.x).attr('y1', a.y).attr('x2', b.x).attr('y2', b.y).attr('stroke', 'var(--gold)').attr('stroke-width', 4.5);
    }
    for (const pp of parents) {
      curve(at(pp, -1), at(focusId, 0));
      for (const g2 of parentsOf(byId.get(pp))) curve(at(g2, -2), at(pp, -1));
    }
    for (const s of sibs) curve(at(parents[0], -1), at(s, 0));
    for (const c of ch) {
      const par = [focusId, ...spousesOf(P)].find((x) => parentsOf(byId.get(c)).includes(x));
      curve(at(par, 0), at(c, 1));
      for (const k of kids(c)) curve(at(c, 1), at(k, 2));
    }
    const drawn = [];
    for (const [lv, ids] of Object.entries(rows)) for (const id of ids) drawn.push({ id, lv, ...at(id, lv) });
    const gs = svg.append('g').selectAll('g').data(drawn).join('g')
      .attr('transform', (d) => `translate(${d.x},${d.y})`).style('cursor', 'pointer')
      .on('click', (e, d) => { if (d.id !== focusId) { focusId = d.id; onFocusChange && onFocusChange(focusId); draw(); } });
    gs.append('circle').attr('r', (d) => d.r)
      .attr('fill', (d) => (d.id === focusId ? clanColor(d.id) : 'var(--paper)'))
      .attr('stroke', (d) => clanColor(d.id)).attr('stroke-width', 3.5);
    gs.append('text').attr('class', 'alt-lbl').attr('text-anchor', 'middle').attr('dy', (d) => d.r + 18)
      .style('font-weight', (d) => (d.id === focusId ? 700 : 400)).text((d) => short(byId.get(d.id).name));
    gs.append('text').attr('class', 'alt-lbl alt-sub').attr('text-anchor', 'middle').attr('dy', (d) => d.r + 35)
      .text((d) => yearsOf(byId.get(d.id)));
    const labels = { '-2': 'Abuelos', '-1': 'Padres', 0: 'Hermanos y pareja', 1: 'Hijos', 2: 'Nietos' };
    for (const [lv, t] of Object.entries(labels)) {
      if (rows[lv].length) svg.append('text').attr('x', 16).attr('y', Y[lv] + 4).attr('class', 'alt-row-label').text(t);
    }
    if (!parents.length) svg.append('text').attr('x', W / 2).attr('y', Y['-1']).attr('text-anchor', 'middle').attr('class', 'alt-row-label').text('Sin padres registrados');
  }
  draw();
}

export async function renderAltView(kind, container, people, opts) {
  await loadD3();
  // A newer render started while d3 was loading (data changed, view switched):
  // let it win instead of drawing twice.
  if (opts.isStale && opts.isStale()) return;
  container.innerHTML = '';
  if (!people.length) return;
  const model = buildModel(people, opts.inLawIds || new Set());
  if (kind === 'net') await renderNetwork(container, model, opts);
  else if (kind === 'rad') await renderRadial(container, model, opts);
  else if (kind === 'foc') await renderFocus(container, model, opts);
}
