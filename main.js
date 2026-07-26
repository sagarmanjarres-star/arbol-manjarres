import {
  subscribePeople,
  addPerson,
  updatePersonDetails,
  addRelationship,
  removeRelationship,
  deletePersonWithCleanup,
  undoDelete,
} from './store.js';
import { renderTree } from './tree.js';
import { computePrintPages } from './print-layout.js';
import { MONTHS_ES_LONG, formatPartialDate } from './dates.js';

const treeContainer = document.getElementById('treeContainer');
const saveStatus = document.getElementById('saveStatus');
const addPersonBtn = document.getElementById('addPersonBtn');
const printBtn = document.getElementById('printBtn');
const savePdfBtn = document.getElementById('savePdfBtn');
const printA3Btn = document.getElementById('printA3Btn');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

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

subscribePeople((newPeople) => {
  people = newPeople.map(normalize);
  renderTreeNow();
});

function renderTreeNow() {
  renderTree(treeContainer, people, { selectedId, onSelectPerson: (id) => openPersonModal({ mode: 'edit', personId: id }) });
}

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
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
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
      <div class="field">
        <label>Fecha de matrimonio (opcional)</label>
        <div class="date-parts">
          <input type="number" id="relMarriageDay" placeholder="Día" min="1" max="31">
          <select id="relMarriageMonth">${monthOptionsHtml()}</select>
          <input type="number" id="relMarriageYear" placeholder="Año" min="1" max="9999">
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
    const marriageDate = formatPartialDate(s.marriageDay, s.marriageMonth, s.marriageYear);
    const dateSuffix = marriageDate ? ` — casados el ${marriageDate}` : '';
    items.push({ label: `Esposo/a (${statusLabel}) de ${escapeHtml(personName(s.id))}${escapeHtml(dateSuffix)}`, onRemove: `removeSpouse('${s.id}')` });
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

  personModalTitle.textContent = editing ? 'Editar persona' : 'Agregar persona';

  const relationshipSection = (!editing && isFirstPerson) ? '' : `
    <fieldset id="relFieldset">
      <legend>${editing ? 'Agregar una relación' : '¿Cómo se relaciona con la familia? (opcional)'}</legend>
      <div class="field">
        <label for="relType">Relación</label>
        <select id="relType">${relTypeOptionsHtml()}</select>
      </div>
      <div id="relSub"></div>
      ${editing ? '<button type="button" id="addRelBtn" class="btn btn-secondary">+ Agregar esta relación</button>' : ''}
    </fieldset>
  `;

  personModalBody.innerHTML = `
    <form id="personForm">
      <div class="field">
        <label for="fName">Nombre</label>
        <input type="text" id="fName" required value="${p ? escapeAttr(p.name) : ''}">
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
        <label>Fecha de fallecimiento</label>
        <div class="date-parts">
          <input type="number" id="fDeathDay" placeholder="Día" min="1" max="31" value="${p?.deathDay ?? ''}">
          <select id="fDeathMonth">${monthOptionsHtml(p?.deathMonth)}</select>
          <input type="number" id="fDeathYear" placeholder="Año" min="1" max="9999" value="${p?.deathYear ?? ''}">
        </div>
        <p class="field-hint">Deja todo en blanco si la persona vive.</p>
      </div>
      <div class="field">
        <label for="fLocation">Lugar</label>
        <input type="text" id="fLocation" placeholder="ciudad, país" value="${p ? escapeAttr(p.location || '') : ''}">
      </div>
      <div class="field">
        <label for="fOccupation">Ocupación</label>
        <input type="text" id="fOccupation" placeholder="ej. ingeniero, ama de casa, médico" value="${p ? escapeAttr(p.occupation || '') : ''}">
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

  document.getElementById('cancelPersonBtn').addEventListener('click', closePersonModal);

  document.getElementById('personForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await handlePersonSave({ editing, personId, isFirstPerson });
  });

  const addRelBtn = document.getElementById('addRelBtn');
  if (addRelBtn) {
    addRelBtn.addEventListener('click', async () => {
      await applyRelationshipFromForm(personId);
      openPersonModal({ mode: 'edit', personId }); // refresh with updated relationship list
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
}

async function applyRelationshipFromForm(personId) {
  const relType = document.getElementById('relType')?.value;
  if (!relType) return;

  if (relType === 'child') {
    const father = document.getElementById('relFather').value;
    const mother = document.getElementById('relMother').value;
    if (father) await addRelationship('parent', personId, father);
    if (mother) await addRelationship('parent', personId, mother);
  } else if (relType === 'parent') {
    const child = document.getElementById('relChild').value;
    if (child) await addRelationship('child', personId, child);
  } else if (relType === 'spouse') {
    const spouse = document.getElementById('relSpouse').value;
    const status = document.querySelector('input[name="spouseStatus"]:checked')?.value || 'current';
    const marriageDate = {
      marriageDay: parseIntInRange(document.getElementById('relMarriageDay').value, 1, 31),
      marriageMonth: parseIntInRange(document.getElementById('relMarriageMonth').value, 1, 12),
      marriageYear: parseIntOrNull(document.getElementById('relMarriageYear').value),
    };
    if (spouse) await addRelationship('spouse', personId, spouse, status, marriageDate);
  } else if (relType === 'sibling') {
    const sibling = document.getElementById('relSibling').value;
    if (sibling) await addRelationship('sibling', personId, sibling);
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
  const location = document.getElementById('fLocation').value.trim();
  const occupation = document.getElementById('fOccupation').value.trim();

  const photoUrl = _pendingPhotoDataUrl;

  const dateFields = { birthDay, birthMonth, birthYear, deathDay, deathMonth, deathYear };

  if (editing) {
    await updatePersonDetails(personId, { name, ...dateFields, location, occupation, photoUrl });
  } else {
    const newId = await addPerson({ name, ...dateFields, location, occupation, founder: isFirstPerson, photoUrl });
    await applyRelationshipFromForm(newId);
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
        renderTreeNow();
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
