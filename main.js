import {
  subscribePeople,
  addPerson,
  updatePersonDetails,
  addRelationship,
  removeRelationship,
  deletePersonWithCleanup,
  undoDelete,
} from './store.js';
import { renderTree, computeLayout, CARD_W } from './tree.js';
import { renderAltView, setFocusId } from './views.js';
import { computePrintPages } from './print-layout.js';
import { MONTHS_ES_LONG } from './dates.js';

// Most people in this tree were born/died in the same village, so a
// one-click chip beats retyping it for the 90% common case.
const COMMON_LOCATION = 'Sieteiglesias de Trabancos (Valladolid)';

function locationChipHtml(targetFieldId) {
  return `<button type="button" class="location-chip" data-fill-target="${targetFieldId}">📍 ${COMMON_LOCATION}</button>`;
}

const treeContainer = document.getElementById('treeContainer');
const saveStatus = document.getElementById('saveStatus');
const addPersonBtn = document.getElementById('addPersonBtn');
const printBtn = document.getElementById('printBtn');
const savePdfBtn = document.getElementById('savePdfBtn');
const printA3Btn = document.getElementById('printA3Btn');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const showBernalToggle = document.getElementById('showBernalToggle');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const zoomResetBtn = document.getElementById('zoomResetBtn');
const viewSelect = document.getElementById('viewSelect');
const altContainer = document.getElementById('altContainer');
const zoomControls = document.querySelector('.zoom-controls');

const pdfTipModal = document.getElementById('pdfTipModal');
const pdfTipContinueBtn = document.getElementById('pdfTipContinueBtn');
const pdfTipCancelBtn = document.getElementById('pdfTipCancelBtn');

const a3TipModal = document.getElementById('a3TipModal');
const a3TipContinueBtn = document.getElementById('a3TipContinueBtn');
const a3TipCancelBtn = document.getElementById('a3TipCancelBtn');

const personModal = document.getElementById('personModal');
const personModalTitle = document.getElementById('personModalTitle');
const personModalBody = document.getElementById('personModalBody');

const confirmModal = document.getElementById('confirmModal');
const confirmMessage = document.getElementById('confirmMessage');
const confirmCancelBtn = document.getElementById('confirmCancelBtn');
const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

const undoToast = document.getElementById('undoToast');
const undoMessage = document.getElementById('undoMessage');
const undoBtn = document.getElementById('undoBtn');

let people = [];
let selectedId = null;
let confirmTargetId = null;
let undoTimer = null;

function toMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  return 0;
}

function normalize(p) {
  return { ...p, createdAtMs: toMs(p.createdAt) };
}

function personName(id) {
  return people.find((p) => p.id === id)?.name || '(desconocido/a)';
}

function childrenOf(id) {
  return people.filter((p) => (p.parentIds || []).includes(id));
}

// The founder's (Delfín's) spouse brings her own blood family into the tree
// (parents, siblings, nieces/nephews...) even though they aren't Manjarrés
// blood. This computes that in-law branch so it can be hidden by default —
// everyone descended from the spouse's own ancestors, minus the spouse
// herself and minus whatever she shares in blood with the founder (their
// children together and onward), which always stays visible.
function computeInLawBranchIds(allPeople) {
  const byId = new Map(allPeople.map((p) => [p.id, p]));
  const founder = allPeople.find((p) => p.founder);
  if (!founder) return new Set();

  function ancestorsOf(id) {
    const out = new Set();
    const p = byId.get(id);
    for (const pid of p?.parentIds || []) {
      if (!byId.has(pid) || out.has(pid)) continue;
      out.add(pid);
      for (const a of ancestorsOf(pid)) out.add(a);
    }
    return out;
  }

  function descendantsOf(rootIds) {
    const all = new Set(rootIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of allPeople) {
        if (all.has(p.id)) continue;
        if ((p.parentIds || []).some((pid) => all.has(pid))) {
          all.add(p.id);
          changed = true;
        }
      }
    }
    return all;
  }

  const sharedClan = descendantsOf([founder.id]);
  const hidden = new Set();
  for (const s of founder.spouses || []) {
    if (!byId.has(s.id)) continue;
    const spouseClan = descendantsOf([s.id, ...ancestorsOf(s.id)]);
    for (const id of spouseClan) {
      if (id !== s.id && !sharedClan.has(id)) hidden.add(id);
    }
  }
  // Someone married into the hidden branch (no parents recorded, and every
  // spouse is hidden) would otherwise be left floating alone at the top of
  // the diagram with nothing to connect to, so they're hidden too.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of allPeople) {
      if (hidden.has(p.id) || (p.parentIds || []).length) continue;
      const spouses = (p.spouses || []).filter((s) => byId.has(s.id));
      if (spouses.length && spouses.every((s) => hidden.has(s.id))) {
        hidden.add(p.id);
        changed = true;
      }
    }
  }
  return hidden;
}

subscribePeople((newPeople) => {
  people = newPeople.map(normalize);
  inLawBranchIds = computeInLawBranchIds(people);
  renderTreeNow();
});

// Which of the ways of looking at the family is showing: the classic tree
// ('tree') or one of the alternative views from views.js. Remembered per
// browser; the family data itself is the same in all of them.
const VIEW_STORAGE_KEY = 'familyTree.view';
const VALID_VIEWS = ['tree', 'net', 'rad', 'foc'];
let currentView = (() => {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    return VALID_VIEWS.includes(v) ? v : 'tree';
  } catch { return 'tree'; }
})();
viewSelect.value = currentView;

function applyViewChrome() {
  const isTree = currentView === 'tree';
  treeContainer.hidden = !isTree;
  zoomControls.hidden = !isTree;
  altContainer.hidden = isTree;
  for (const b of [printBtn, savePdfBtn, printA3Btn]) {
    b.disabled = !isTree;
    b.title = isTree ? '' : 'Cambia a la vista "Árbol (clásico)" para imprimir';
  }
}

viewSelect.addEventListener('change', () => {
  currentView = viewSelect.value;
  try { localStorage.setItem(VIEW_STORAGE_KEY, currentView); } catch { /* not persisted */ }
  renderTreeNow();
});

let altRenderToken = 0;

function renderTreeNow() {
  const visiblePeople = showBernalToggle.checked
    ? people
    : people.filter((p) => !inLawBranchIds.has(p.id));
  applyViewChrome();

  if (currentView !== 'tree') {
    const token = ++altRenderToken;
    renderAltView(currentView, altContainer, visiblePeople, {
      selectedId,
      inLawIds: inLawBranchIds,
      isStale: () => token !== altRenderToken,
      onSelectPerson: (id) => openPersonModal({ mode: 'edit', personId: id }),
      onFocusChange: (id) => { selectedId = id; },
    }).catch(() => {
      if (token === altRenderToken) altContainer.textContent = 'No se pudo cargar esta vista. Revisa tu conexión a internet e inténtalo de nuevo.';
    });
    return;
  }

  renderTree(treeContainer, visiblePeople, {
    selectedId,
    onSelectPerson: (id) => openPersonModal({ mode: 'edit', personId: id }),
    collapsedKeys,
    onToggleCollapse,
  });
  if (!hasCenteredOnce && visiblePeople.length) {
    hasCenteredOnce = true;
    centerViewOn(visiblePeople.find((p) => p.founder) || visiblePeople[0], visiblePeople);
  }
  applyZoomPan();
}

let inLawBranchIds = new Set();

// ---------- Collapse/expand branches ----------
// A branch is identified by its parentKey (same joined-id string tree.js
// uses for a couple's children) rather than a single person id, so
// collapsing a couple's branch collapses it for both of them, and a person
// with children from two different partners can collapse just one of those
// branches independently. Persisted per-browser (not synced to Firestore —
// it's just a screen decluttering preference, not family data).
const COLLAPSED_KEYS_STORAGE_KEY = 'familyTree.collapsedKeys';

function loadCollapsedKeys() {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEYS_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedKeys() {
  try {
    localStorage.setItem(COLLAPSED_KEYS_STORAGE_KEY, JSON.stringify([...collapsedKeys]));
  } catch {
    // Private browsing / storage full — collapse state just won't persist.
  }
}

let collapsedKeys = loadCollapsedKeys();

function onToggleCollapse(key) {
  if (collapsedKeys.has(key)) collapsedKeys.delete(key);
  else collapsedKeys.add(key);
  saveCollapsedKeys();
  renderTreeNow();
}

// Un-collapses every ancestor branch above this person so they're actually
// visible — used before jumping to a search result, since otherwise
// clicking a match hidden inside a collapsed branch would silently do
// nothing. Returns whether anything changed.
function ensureExpandedTo(personId) {
  const byId = new Map(people.map((p) => [p.id, p]));
  let changed = false;
  const queue = [personId];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const parentIds = byId.get(id)?.parentIds || [];
    if (parentIds.length) {
      const key = parentIds.slice().sort().join(',');
      if (collapsedKeys.delete(key)) changed = true;
      for (const pid of parentIds) queue.push(pid);
    }
  }
  if (changed) saveCollapsedKeys();
  return changed;
}

showBernalToggle.addEventListener('change', renderTreeNow);

// ---------- Pan & zoom ----------
// The tree canvas is rendered at full pixel size by tree.js (often 15,000px+
// wide for this family) and .tree-container clips it (overflow: hidden) —
// this section is what lets you actually get around inside that clipped
// view: drag to pan, wheel or the +/− buttons to zoom, all done by
// transforming the canvas element itself rather than relying on native
// scrollbars, which don't shrink/grow with zoom.
let zoomScale = 1;
let panX = 0;
let panY = 0;
let hasCenteredOnce = false;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panOriginX = 0;
let panOriginY = 0;

function clampScale(s) {
  return Math.min(2.5, Math.max(0.15, s));
}

function applyZoomPan() {
  const canvas = treeContainer.querySelector('.tree-canvas');
  if (!canvas) return;
  canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
}

// Keeps the point under (clientX, clientY) visually fixed while the scale
// changes, so zooming with the wheel zooms toward the cursor instead of
// toward the canvas's top-left corner.
function zoomBy(delta, clientX, clientY) {
  const oldScale = zoomScale;
  const newScale = clampScale(oldScale + delta);
  if (newScale === oldScale) return;
  const rect = treeContainer.getBoundingClientRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  panX = cx - (cx - panX) * (newScale / oldScale);
  panY = cy - (cy - panY) * (newScale / oldScale);
  zoomScale = newScale;
  applyZoomPan();
}

function centerViewOn(person, visiblePeople) {
  if (!person) return;
  const { pos } = computeLayout(visiblePeople, collapsedKeys);
  const at = pos.get(person.id);
  if (!at) return;
  const rect = treeContainer.getBoundingClientRect();
  panX = rect.width / 2 - (at.x + CARD_W / 2) * zoomScale;
  panY = rect.height / 3 - at.y * zoomScale;
}

treeContainer.addEventListener('wheel', (e) => {
  e.preventDefault();
  // deltaY magnitude varies a lot between a mouse wheel notch (~100) and a
  // trackpad's stream of small events (~1-10), so scale the step by it
  // instead of using a fixed amount — otherwise trackpad zoom feels frantic.
  const step = Math.min(0.08, Math.abs(e.deltaY) * 0.008);
  zoomBy(e.deltaY < 0 ? step : -step, e.clientX, e.clientY);
}, { passive: false });

treeContainer.addEventListener('mousedown', (e) => {
  if (e.target.closest('.person-card')) return; // let card clicks through untouched
  isPanning = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
  panOriginX = panX;
  panOriginY = panY;
  treeContainer.classList.add('grabbing');
});
window.addEventListener('mousemove', (e) => {
  if (!isPanning) return;
  panX = panOriginX + (e.clientX - panStartX);
  panY = panOriginY + (e.clientY - panStartY);
  applyZoomPan();
});
window.addEventListener('mouseup', () => {
  isPanning = false;
  treeContainer.classList.remove('grabbing');
});

// Single-finger touch pan (tablets/phones); pinch-to-zoom isn't handled,
// the on-screen +/− buttons cover zoom on touch devices.
treeContainer.addEventListener('touchstart', (e) => {
  if (e.target.closest('.person-card') || e.touches.length !== 1) return;
  isPanning = true;
  panStartX = e.touches[0].clientX;
  panStartY = e.touches[0].clientY;
  panOriginX = panX;
  panOriginY = panY;
}, { passive: true });
treeContainer.addEventListener('touchmove', (e) => {
  if (!isPanning || e.touches.length !== 1) return;
  panX = panOriginX + (e.touches[0].clientX - panStartX);
  panY = panOriginY + (e.touches[0].clientY - panStartY);
  applyZoomPan();
}, { passive: true });
treeContainer.addEventListener('touchend', () => { isPanning = false; });

zoomInBtn.addEventListener('click', () => {
  const rect = treeContainer.getBoundingClientRect();
  zoomBy(0.2, rect.left + rect.width / 2, rect.top + rect.height / 2);
});
zoomOutBtn.addEventListener('click', () => {
  const rect = treeContainer.getBoundingClientRect();
  zoomBy(-0.2, rect.left + rect.width / 2, rect.top + rect.height / 2);
});
zoomResetBtn.addEventListener('click', () => {
  zoomScale = 1;
  hasCenteredOnce = false;
  renderTreeNow();
});

function flashSaved() {
  saveStatus.textContent = 'Guardado ✓';
  saveStatus.style.opacity = '1';
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => { saveStatus.style.opacity = '0'; }, 2200);
}

// ---------- Add / Edit modal ----------

function optionsHtml(excludeIds = []) {
  const excl = new Set(excludeIds);
  return people
    .filter((p) => !excl.has(p.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'es'))
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.hidden ? ' (marcador oculto)' : ''}</option>`)
    .join('');
}

function monthOptionsHtml(selectedMonth) {
  const opts = MONTHS_ES_LONG.map((label, i) => {
    const value = i + 1;
    return `<option value="${value}" ${selectedMonth === value ? 'selected' : ''}>${label}</option>`;
  }).join('');
  return `<option value="">Mes</option>${opts}`;
}

function relTypeOptionsHtml() {
  return `
    <option value="">— Ninguna, persona nueva sin conexión —</option>
    <option value="child">Es hijo/a de alguien en el árbol</option>
    <option value="parent">Es padre o madre de alguien en el árbol</option>
    <option value="spouse">Es esposo/a de alguien en el árbol</option>
    <option value="sibling">Es hermano/a de alguien en el árbol</option>
  `;
}

function relSubHtml(type, excludeId) {
  const opts = optionsHtml(excludeId ? [excludeId] : []);
  if (type === 'child') {
    return `
      <div class="field">
        <label for="relFather">Padre</label>
        <select id="relFather"><option value="">— Ninguno / no está en el árbol —</option>${opts}</select>
      </div>
      <div class="field">
        <label for="relMother">Madre</label>
        <select id="relMother"><option value="">— Ninguna / no está en el árbol —</option>${opts}</select>
      </div>
    `;
  }
  if (type === 'parent') {
    return `
      <div class="field">
        <label for="relChild">Hijo/a</label>
        <select id="relChild" required><option value="">— Selecciona una persona —</option>${opts}</select>
      </div>
    `;
  }
  if (type === 'spouse') {
    return `
      <div class="field">
        <label for="relSpouse">Esposo/a</label>
        <select id="relSpouse" required><option value="">— Selecciona una persona —</option>${opts}</select>
      </div>
      <div class="field">
        <label>Estado</label>
        <div class="radio-group">
          <label><input type="radio" name="spouseStatus" value="current" checked> Actual</label>
          <label><input type="radio" name="spouseStatus" value="former"> Matrimonio anterior</label>
        </div>
      </div>
    `;
  }
  if (type === 'sibling') {
    return `
      <div class="field">
        <label for="relSibling">Hermano/a</label>
        <select id="relSibling" required><option value="">— Selecciona una persona —</option>${opts}</select>
      </div>
    `;
  }
  return '';
}

function relationshipListHtml(personId) {
  const p = people.find((pp) => pp.id === personId);
  if (!p) return '';
  const items = [];

  for (const pid of p.parentIds || []) {
    items.push({ label: `Hijo/a de ${escapeHtml(personName(pid))}`, onRemove: `removeParent('${pid}')` });
  }
  for (const c of childrenOf(personId)) {
    items.push({ label: `Padre/madre de ${escapeHtml(c.name)}`, onRemove: `removeChild('${c.id}')` });
  }
  for (const s of p.spouses || []) {
    const statusLabel = s.status === 'former' ? 'matrimonio anterior' : 'actual';
    items.push({ label: `Esposo/a (${statusLabel}) de ${escapeHtml(personName(s.id))}`, onRemove: `removeSpouse('${s.id}')` });
  }
  for (const sid of p.siblingIds || []) {
    items.push({ label: `Hermano/a de ${escapeHtml(personName(sid))}`, onRemove: `removeSibling('${sid}')` });
  }

  if (!items.length) return '<p class="field-hint">Todavía no tiene relaciones registradas.</p>';

  return `<ul class="relationship-list">${items.map((it) => `
    <li><span>${it.label}</span><button type="button" class="btn-link" onclick="window.__familyTree.${it.onRemove}">Quitar</button></li>
  `).join('')}</ul>`;
}

function openPersonModal({ mode, personId }) {
  const editing = mode === 'edit';
  _currentEditPersonId = editing ? personId : null;
  const p = editing ? people.find((pp) => pp.id === personId) : null;
  const isFirstPerson = !editing && people.length === 0;
  if (!editing) _pendingNewRelations = [];

  personModalTitle.textContent = editing ? 'Editar persona' : 'Agregar persona';

  const relationshipSection = (!editing && isFirstPerson) ? '' : `
    <fieldset id="relFieldset">
      <legend>${editing ? 'Agregar una relación' : '¿Cómo se relaciona con la familia? (opcional)'}</legend>
      ${editing ? '' : `<div id="pendingRelWrap">${pendingRelationsListHtml()}</div>`}
      <div class="field">
        <label for="relType">Relación</label>
        <select id="relType">${relTypeOptionsHtml()}</select>
      </div>
      <div id="relSub"></div>
      <button type="button" id="addRelBtn" class="btn btn-secondary">+ Agregar esta relación</button>
      ${editing ? '' : '<p class="field-hint">Puedes agregar varias relaciones antes de guardar.</p>'}
    </fieldset>
  `;

  personModalBody.innerHTML = `
    <form id="personForm">
      <div class="field">
        <label for="fName">Nombre</label>
        <input type="text" id="fName" required value="${p ? escapeAttr(p.name) : ''}">
      </div>
      <div class="field field-checkbox">
        <label><input type="checkbox" id="fHidden" ${p?.hidden ? 'checked' : ''}> Marcador de generación (no se muestra en el árbol)</label>
        <p class="field-hint">Úsalo cuando no conoces el nombre de un antepasado pero sabes que existió — por ejemplo, para marcar que alguien tiene un padre o madre desconocido y así ubicar correctamente su generación. No aparece como tarjeta en el árbol.</p>
      </div>
      <div class="field">
        <label>Fecha de nacimiento</label>
        <div class="date-parts">
          <input type="number" id="fBirthDay" placeholder="Día" min="1" max="31" value="${p?.birthDay ?? ''}">
          <select id="fBirthMonth">${monthOptionsHtml(p?.birthMonth)}</select>
          <input type="number" id="fBirthYear" placeholder="Año" min="1" max="9999" value="${p?.birthYear ?? ''}">
        </div>
        <p class="field-hint">Día y mes son opcionales — deja en blanco lo que no sepas.</p>
      </div>
      <div class="field">
        <label for="fLocation">Lugar de nacimiento</label>
        <input type="text" id="fLocation" placeholder="ciudad, país" value="${p ? escapeAttr(p.location || '') : ''}">
        ${locationChipHtml('fLocation')}
      </div>
      <div class="field">
        <label>Fecha de fallecimiento</label>
        <div class="date-parts">
          <input type="number" id="fDeathDay" placeholder="Día" min="1" max="31" value="${p?.deathDay ?? ''}">
          <select id="fDeathMonth">${monthOptionsHtml(p?.deathMonth)}</select>
          <input type="number" id="fDeathYear" placeholder="Año" min="1" max="9999" value="${p?.deathYear ?? ''}">
        </div>
        <p class="field-hint">Deja todo en blanco si la persona vive.</p>
      </div>
      <div class="field">
        <label for="fDeathPlace">Lugar de fallecimiento</label>
        <input type="text" id="fDeathPlace" placeholder="ciudad, país" value="${p ? escapeAttr(p.deathPlace || '') : ''}">
        ${locationChipHtml('fDeathPlace')}
      </div>
      <div class="field">
        <label for="fPhotoFile">Foto (opcional)</label>
        <div id="photoPreviewWrap" class="photo-preview-wrap"></div>
        <input type="file" id="fPhotoFile" accept="image/*">
        <button type="button" id="removePhotoBtn" class="btn-link" hidden>Quitar foto</button>
      </div>

      ${editing ? `<div class="field"><label>Relaciones actuales</label>${relationshipListHtml(personId)}</div>` : ''}

      ${relationshipSection}

      <div class="modal-actions">
        ${editing ? '<button type="button" id="deletePersonBtn" class="btn btn-danger btn-big">🗑️ Eliminar persona</button>' : ''}
        <button type="button" id="cancelPersonBtn" class="btn btn-secondary btn-big">Cancelar</button>
        <button type="submit" class="btn btn-primary btn-big">${editing ? 'Guardar cambios' : 'Guardar'}</button>
      </div>
    </form>
  `;

  const relType = document.getElementById('relType');
  const relSub = document.getElementById('relSub');
  if (relType) {
    relType.addEventListener('change', () => {
      relSub.innerHTML = relSubHtml(relType.value, editing ? personId : null);
    });
  }

  document.querySelectorAll('.location-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById(chip.dataset.fillTarget).value = COMMON_LOCATION;
    });
  });

  document.getElementById('cancelPersonBtn').addEventListener('click', closePersonModal);

  document.getElementById('personForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await handlePersonSave({ editing, personId, isFirstPerson });
  });

  const addRelBtn = document.getElementById('addRelBtn');
  if (addRelBtn) {
    addRelBtn.addEventListener('click', async () => {
      if (editing) {
        await applyRelationshipFromForm(personId);
        openPersonModal({ mode: 'edit', personId }); // refresh with updated relationship list
      } else {
        const drafts = relationDraftsFromForm();
        if (!drafts.length) return;
        _pendingNewRelations.push(...drafts);
        document.getElementById('pendingRelWrap').innerHTML = pendingRelationsListHtml();
        wirePendingRelRemoveButtons();
        relType.value = '';
        relSub.innerHTML = '';
      }
    });
  }

  const deleteBtn = document.getElementById('deletePersonBtn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      closePersonModal();
      openConfirmModal(personId);
    });
  }

  _pendingPhotoDataUrl = p?.photoUrl || null;
  renderPhotoPreview();

  document.getElementById('fPhotoFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      _pendingPhotoDataUrl = await resizePhotoToDataUrl(file);
    } catch (err) {
      alert('No se pudo procesar esa foto. Intenta con otra.');
      return;
    }
    renderPhotoPreview();
  });

  document.getElementById('removePhotoBtn').addEventListener('click', () => {
    _pendingPhotoDataUrl = null;
    document.getElementById('fPhotoFile').value = '';
    renderPhotoPreview();
  });

  personModal.hidden = false;
}

let _pendingPhotoDataUrl = null;

function renderPhotoPreview() {
  const wrap = document.getElementById('photoPreviewWrap');
  const removeBtn = document.getElementById('removePhotoBtn');
  if (!wrap) return;
  wrap.innerHTML = _pendingPhotoDataUrl
    ? `<img src="${_pendingPhotoDataUrl}" class="photo-preview" alt="">`
    : '<div class="photo-preview photo-preview-empty">Sin foto</div>';
  if (removeBtn) removeBtn.hidden = !_pendingPhotoDataUrl;
}

// Shrinks a chosen photo to a small JPEG data URL before saving, so a
// person doc (and the realtime snapshot listener payload) stays tiny —
// Firestore documents cap out at 1MB and this app has no file storage
// backend, so the photo lives inline in the document.
async function resizePhotoToDataUrl(file, maxDim = 480, quality = 0.75) {
  const bitmap = await loadImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  if (dataUrl.length > 900_000) throw new Error('photo too large');
  return dataUrl;
}

async function loadImageBitmap(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // fall through to the <img> based path below
    }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function closePersonModal() {
  personModal.hidden = true;
  personModalBody.innerHTML = '';
  _pendingNewRelations = [];
}

// Relationships queued while creating a brand-new person, applied once the
// person is actually saved (there's no id to attach them to before that).
let _pendingNewRelations = [];

function pendingRelationsListHtml() {
  if (!_pendingNewRelations.length) return '<p class="field-hint">Todavía no agregaste ninguna relación.</p>';
  return `<ul class="relationship-list">${_pendingNewRelations.map((r, i) => `
    <li><span>${escapeHtml(r.label)}</span><button type="button" class="btn-link" data-pending-idx="${i}">Quitar</button></li>
  `).join('')}</ul>`;
}

function wirePendingRelRemoveButtons() {
  document.querySelectorAll('[data-pending-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _pendingNewRelations.splice(Number(btn.dataset.pendingIdx), 1);
      document.getElementById('pendingRelWrap').innerHTML = pendingRelationsListHtml();
      wirePendingRelRemoveButtons();
    });
  });
}

// Reads the relation currently selected in the form (used both to queue a
// relation via "+ Agregar esta relación" and to pick up whatever's left
// selected when a new person is saved without clicking that button first).
function relationDraftsFromForm() {
  const relType = document.getElementById('relType')?.value;
  if (!relType) return [];

  if (relType === 'child') {
    const father = document.getElementById('relFather').value;
    const mother = document.getElementById('relMother').value;
    const drafts = [];
    if (father) drafts.push({ type: 'parent', relatedId: father, label: `Hijo/a de ${escapeHtml(personName(father))}` });
    if (mother) drafts.push({ type: 'parent', relatedId: mother, label: `Hijo/a de ${escapeHtml(personName(mother))}` });
    return drafts;
  }
  if (relType === 'parent') {
    const child = document.getElementById('relChild').value;
    return child ? [{ type: 'child', relatedId: child, label: `Padre/madre de ${escapeHtml(personName(child))}` }] : [];
  }
  if (relType === 'spouse') {
    const spouse = document.getElementById('relSpouse').value;
    const status = document.querySelector('input[name="spouseStatus"]:checked')?.value || 'current';
    if (!spouse) return [];
    const statusLabel = status === 'former' ? 'matrimonio anterior' : 'actual';
    return [{ type: 'spouse', relatedId: spouse, status, label: `Esposo/a (${statusLabel}) de ${escapeHtml(personName(spouse))}` }];
  }
  if (relType === 'sibling') {
    const sibling = document.getElementById('relSibling').value;
    return sibling ? [{ type: 'sibling', relatedId: sibling, label: `Hermano/a de ${escapeHtml(personName(sibling))}` }] : [];
  }
  return [];
}

async function applyRelationshipFromForm(personId) {
  const drafts = relationDraftsFromForm();
  for (const r of drafts) {
    await addRelationship(r.type, personId, r.relatedId, r.status);
  }
  flashSaved();
}

async function handlePersonSave({ editing, personId, isFirstPerson }) {
  const name = document.getElementById('fName').value.trim();
  if (!name) return;
  const birthDay = parseIntInRange(document.getElementById('fBirthDay').value, 1, 31);
  const birthMonth = parseIntInRange(document.getElementById('fBirthMonth').value, 1, 12);
  const birthYear = parseIntOrNull(document.getElementById('fBirthYear').value);
  const deathDay = parseIntInRange(document.getElementById('fDeathDay').value, 1, 31);
  const deathMonth = parseIntInRange(document.getElementById('fDeathMonth').value, 1, 12);
  const deathYear = parseIntOrNull(document.getElementById('fDeathYear').value);
  const deathPlace = document.getElementById('fDeathPlace').value.trim();
  const location = document.getElementById('fLocation').value.trim();
  const hidden = document.getElementById('fHidden').checked;

  const photoUrl = _pendingPhotoDataUrl;

  const dateFields = { birthDay, birthMonth, birthYear, deathDay, deathMonth, deathYear, deathPlace };

  if (editing) {
    await updatePersonDetails(personId, { name, ...dateFields, location, photoUrl, hidden });
  } else {
    const newId = await addPerson({ name, ...dateFields, location, founder: isFirstPerson, photoUrl, hidden });
    for (const r of _pendingNewRelations) {
      await addRelationship(r.type, newId, r.relatedId, r.status);
    }
    await applyRelationshipFromForm(newId); // whatever's still selected but not queued
  }
  flashSaved();
  closePersonModal();
}

function parseIntOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function parseIntInRange(v, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// Exposed for the inline "Quitar" buttons in the relationship list.
window.__familyTree = {
  removeParent: async (parentId) => {
    const id = currentEditPersonId();
    await removeRelationship('parent', id, parentId);
    flashSaved();
    openPersonModal({ mode: 'edit', personId: id });
  },
  removeChild: async (childId) => {
    await removeRelationship('parent', childId, currentEditPersonId());
    flashSaved();
    openPersonModal({ mode: 'edit', personId: currentEditPersonId() });
  },
  removeSpouse: async (spouseId) => {
    const id = currentEditPersonId();
    await removeRelationship('spouse', id, spouseId);
    flashSaved();
    openPersonModal({ mode: 'edit', personId: id });
  },
  removeSibling: async (siblingId) => {
    const id = currentEditPersonId();
    await removeRelationship('sibling', id, siblingId);
    flashSaved();
    openPersonModal({ mode: 'edit', personId: id });
  },
};

let _currentEditPersonId = null;
function currentEditPersonId() { return _currentEditPersonId; }

addPersonBtn.addEventListener('click', () => openPersonModal({ mode: 'add' }));

// ---------- Delete confirmation ----------

function openConfirmModal(personId) {
  confirmTargetId = personId;
  confirmMessage.textContent = `¿Seguro que deseas eliminar a ${personName(personId)}? Esta acción no se puede deshacer.`;
  confirmModal.hidden = false;
}

confirmCancelBtn.addEventListener('click', () => {
  confirmModal.hidden = true;
  confirmTargetId = null;
});

confirmDeleteBtn.addEventListener('click', async () => {
  const id = confirmTargetId;
  const name = personName(id);
  confirmModal.hidden = true;
  confirmTargetId = null;
  if (!id) return;

  const result = await deletePersonWithCleanup(id, people);
  flashSaved();
  showUndoToast(name, result);
});

// ---------- Undo toast ----------

function showUndoToast(name, result) {
  clearTimeout(undoTimer);
  undoMessage.textContent = `${name} fue eliminado.`;
  undoToast.hidden = false;

  const onUndo = async () => {
    await undoDelete(result);
    flashSaved();
    hideUndoToast();
    undoBtn.removeEventListener('click', onUndo);
  };
  undoBtn.addEventListener('click', onUndo);

  undoTimer = setTimeout(() => {
    hideUndoToast();
    undoBtn.removeEventListener('click', onUndo);
  }, 6000);
}

function hideUndoToast() {
  undoToast.hidden = true;
}

// ---------- Search ----------

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    searchResults.hidden = true;
    searchResults.innerHTML = '';
    return;
  }
  const matches = people.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length) {
    searchResults.innerHTML = '<div class="search-result-item">Sin resultados</div>';
  } else {
    searchResults.innerHTML = matches.map((p) => `<button type="button" class="search-result-item" data-id="${p.id}">${escapeHtml(p.name)}</button>`).join('');
    searchResults.querySelectorAll('[data-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedId = btn.dataset.id;
        searchInput.value = '';
        searchResults.hidden = true;
        if (currentView !== 'tree') {
          if (currentView === 'foc') setFocusId(selectedId);
          renderTreeNow();
          return;
        }
        ensureExpandedTo(selectedId);
        renderTreeNow();
        const visiblePeople = showBernalToggle.checked ? people : people.filter((p) => !inLawBranchIds.has(p.id));
        centerViewOn(visiblePeople.find((p) => p.id === selectedId), visiblePeople);
        applyZoomPan();
      });
    });
  }
  searchResults.hidden = false;
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box')) searchResults.hidden = true;
});

// ---------- Print ----------

const PRINT_HEADER_H_PX = 56; // must match the header block built below

// 'a4' is the default multi-page paginated export; 'a3' is the print-shop
// export triggered by printA3Btn — always one sheet, sized for A3 landscape.
let printMode = 'a4';
let printPageSizeStyleEl = null;

// @page rules can't be scoped with a class selector, so to get a single A3
// sheet we inject a plain <style> with a later @page block right before
// printing — the later rule in document order wins over style.css's default
// A4 @page — then remove it again once the print/PDF flow is done.
function applyPrintPageSize(mode) {
  printPageSizeStyleEl?.remove();
  printPageSizeStyleEl = null;
  if (mode === 'a3') {
    printPageSizeStyleEl = document.createElement('style');
    printPageSizeStyleEl.textContent = '@page { size: A3 landscape; margin: 10mm; }';
    document.head.appendChild(printPageSizeStyleEl);
  }
}

// Builds one .print-page per entry from computePrintPages, each a clone of
// the already-rendered tree canvas cropped (via overflow:hidden) and
// shifted/scaled so only that page's slice of the diagram shows. This runs
// instead of scaling the live canvas in place, so a big tree becomes several
// full-size, legible sheets rather than one tiny shrunk one.
function buildPrintPages() {
  const canvas = document.querySelector('.tree-canvas');
  if (!canvas) return;

  applyPrintPageSize(printMode);

  const pageOptions = printMode === 'a3'
    ? { pageWidthMm: 420, pageHeightMm: 297, forceSinglePage: true }
    : {};
  const { scale, pages } = computePrintPages(people, PRINT_HEADER_H_PX, pageOptions);

  const root = document.createElement('div');
  root.id = 'printPagesRoot';

  pages.forEach((desc, i) => {
    const pageEl = document.createElement('section');
    pageEl.className = 'print-page';
    pageEl.style.width = Math.ceil((desc.xEnd - desc.xStart) * scale) + 'px';
    pageEl.style.height = Math.ceil((desc.yEnd - desc.yStart) * scale + PRINT_HEADER_H_PX) + 'px';

    const header = document.createElement('div');
    header.className = 'print-page-header';
    header.innerHTML = `
      <h1>🌳 Árbol de la Familia Manjarres</h1>
      <p>Creado por Delfín Manjarres${pages.length > 1 ? ` · Página ${i + 1} de ${pages.length}` : ''}</p>
    `;
    pageEl.appendChild(header);

    const crop = document.createElement('div');
    crop.className = 'print-page-crop';
    crop.style.height = Math.ceil((desc.yEnd - desc.yStart) * scale) + 'px';

    const clone = canvas.cloneNode(true);
    clone.style.transform = `scale(${scale}) translate(${-desc.xStart}px, ${-desc.yStart}px)`;
    crop.appendChild(clone);
    pageEl.appendChild(crop);

    root.appendChild(pageEl);
  });

  document.body.appendChild(root);
  treeContainer.classList.add('print-hidden');
}

function clearPrintPages() {
  document.getElementById('printPagesRoot')?.remove();
  treeContainer.classList.remove('print-hidden');
  applyPrintPageSize('a4');
  printMode = 'a4';
}

window.addEventListener('beforeprint', buildPrintPages);
window.addEventListener('afterprint', clearPrintPages);

printBtn.addEventListener('click', () => {
  printMode = 'a4';
  window.print();
});

pdfTipContinueBtn.addEventListener('click', () => {
  pdfTipModal.hidden = true;
  printMode = 'a4';
  window.print();
});
pdfTipCancelBtn.addEventListener('click', () => {
  pdfTipModal.hidden = true;
});
savePdfBtn.addEventListener('click', () => {
  pdfTipModal.hidden = false;
});

a3TipContinueBtn.addEventListener('click', () => {
  a3TipModal.hidden = true;
  printMode = 'a3';
  window.print();
});
a3TipCancelBtn.addEventListener('click', () => {
  a3TipModal.hidden = true;
});
printA3Btn.addEventListener('click', () => {
  a3TipModal.hidden = false;
});

// ---------- Helpers ----------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}
