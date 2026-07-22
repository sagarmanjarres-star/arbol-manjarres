// Dev-only stand-in for people-store.js, backed by localStorage instead
// of Firestore. Same exported function names/shapes so main.js doesn't
// know or care which one it's talking to. Activated by opening the app
// with ?mock=1 in the URL — useful for trying changes without touching
// the real family tree data. Never used by the deployed app unless that
// query param is present.

const KEY = 'familyTreeMockPeople';
let listeners = [];

function readAll() {
  return JSON.parse(localStorage.getItem(KEY) || '[]');
}

function writeAll(people) {
  localStorage.setItem(KEY, JSON.stringify(people));
  listeners.forEach((fn) => fn(people));
}

function uid() {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}

export function subscribePeople(onChange) {
  listeners.push(onChange);
  onChange(readAll());
  return () => {
    listeners = listeners.filter((fn) => fn !== onChange);
  };
}

export async function addPerson({ name, birthYear, deathYear, location, founder, photoUrl }) {
  const people = readAll();
  const id = uid();
  people.push({
    id,
    name: name.trim(),
    birthYear: birthYear ?? null,
    deathYear: deathYear ?? null,
    location: (location || '').trim(),
    founder: !!founder,
    photoUrl: photoUrl ?? null,
    parentIds: [],
    spouses: [],
    siblingIds: [],
    createdAt: Date.now(),
  });
  writeAll(people);
  return id;
}

export async function updatePersonDetails(id, { name, birthYear, deathYear, location, photoUrl }) {
  const people = readAll();
  const p = people.find((p) => p.id === id);
  if (!p) return;
  Object.assign(p, {
    name: name.trim(),
    birthYear: birthYear ?? null,
    deathYear: deathYear ?? null,
    location: (location || '').trim(),
    photoUrl: photoUrl ?? null,
  });
  writeAll(people);
}

export async function addRelationship(type, personId, relatedId, status) {
  const people = readAll();
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  if (type === 'parent') {
    addUnique(byId[personId], 'parentIds', relatedId);
  } else if (type === 'child') {
    addUnique(byId[relatedId], 'parentIds', personId);
  } else if (type === 'sibling') {
    addUnique(byId[personId], 'siblingIds', relatedId);
    addUnique(byId[relatedId], 'siblingIds', personId);
  } else if (type === 'spouse') {
    setSpouse(byId[personId], relatedId, status || 'current');
    setSpouse(byId[relatedId], personId, status || 'current');
  }
  writeAll(people);
}

export async function removeRelationship(type, personId, relatedId) {
  const people = readAll();
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  if (type === 'parent') {
    byId[personId].parentIds = byId[personId].parentIds.filter((v) => v !== relatedId);
  } else if (type === 'sibling') {
    byId[personId].siblingIds = byId[personId].siblingIds.filter((v) => v !== relatedId);
    byId[relatedId].siblingIds = byId[relatedId].siblingIds.filter((v) => v !== personId);
  } else if (type === 'spouse') {
    byId[personId].spouses = byId[personId].spouses.filter((s) => s.id !== relatedId);
    byId[relatedId].spouses = byId[relatedId].spouses.filter((s) => s.id !== personId);
  }
  writeAll(people);
}

function addUnique(person, field, value) {
  if (!person[field].includes(value)) person[field].push(value);
}

function setSpouse(person, relatedId, status) {
  person.spouses = person.spouses.filter((s) => s.id !== relatedId);
  person.spouses.push({ id: relatedId, status });
}

export async function deletePersonWithCleanup(id) {
  const people = readAll();
  const deletedData = people.find((p) => p.id === id);
  const touched = [];
  const remaining = [];
  for (const p of people) {
    if (p.id === id) continue;
    const hadParent = p.parentIds?.includes(id);
    const hadSibling = p.siblingIds?.includes(id);
    const hadSpouse = p.spouses?.some((s) => s.id === id);
    if (hadParent || hadSibling || hadSpouse) {
      touched.push({ id: p.id, parentIds: [...p.parentIds], siblingIds: [...p.siblingIds], spouses: [...p.spouses] });
    }
    remaining.push({
      ...p,
      parentIds: p.parentIds.filter((v) => v !== id),
      siblingIds: p.siblingIds.filter((v) => v !== id),
      spouses: p.spouses.filter((s) => s.id !== id),
    });
  }
  writeAll(remaining);
  return { deletedData, touched };
}

export async function undoDelete({ deletedData, touched }) {
  const people = readAll();
  people.push(deletedData);
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  for (const t of touched) {
    Object.assign(byId[t.id], t);
  }
  writeAll(people);
}
