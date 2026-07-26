// Firestore-backed data layer. Every person is one document in the
// "people" collection. Relationships are stored as arrays of ids (or, for
// spouses, small {id, status} records) on each document rather than in a
// separate table — the whole tree is small enough that this stays simple.
//
// Shape of a person doc:
//   {
//     name: string,
//     birthDay, birthMonth, birthYear: number|null,
//     deathDay, deathMonth, deathYear: number|null,
//     location: string,
//     deathPlace: string,
//     occupation: string,
//     parentIds: string[],
//     spouses: { id: string, status: 'current'|'former' }[],
//     siblingIds: string[],
//     createdAt, updatedAt: server timestamps
//   }
//
// Children are never stored directly — they're derived by looking for
// people whose parentIds contains a given id. That keeps parent/child
// edits one-directional and avoids the two copies drifting apart.

import { db, authReady } from './firebase-init.js';
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const peopleCol = collection(db, 'people');

export function subscribePeople(onChange) {
  let unsub = () => {};
  authReady.then(() => {
    unsub = onSnapshot(peopleCol, (snap) => {
      const people = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      onChange(people);
    });
  });
  return () => unsub();
}

export async function addPerson({ name, birthDay, birthMonth, birthYear, deathDay, deathMonth, deathYear, location, deathPlace, occupation, founder, photoUrl }) {
  await authReady;
  const ref = await addDoc(peopleCol, {
    name: name.trim(),
    birthDay: birthDay ?? null,
    birthMonth: birthMonth ?? null,
    birthYear: birthYear ?? null,
    deathDay: deathDay ?? null,
    deathMonth: deathMonth ?? null,
    deathYear: deathYear ?? null,
    location: (location || '').trim(),
    deathPlace: (deathPlace || '').trim(),
    occupation: (occupation || '').trim(),
    founder: !!founder,
    photoUrl: photoUrl ?? null,
    parentIds: [],
    spouses: [],
    siblingIds: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updatePersonDetails(id, { name, birthDay, birthMonth, birthYear, deathDay, deathMonth, deathYear, location, deathPlace, occupation, photoUrl }) {
  await authReady;
  await updateDoc(doc(peopleCol, id), {
    name: name.trim(),
    birthDay: birthDay ?? null,
    birthMonth: birthMonth ?? null,
    birthYear: birthYear ?? null,
    deathDay: deathDay ?? null,
    deathMonth: deathMonth ?? null,
    deathYear: deathYear ?? null,
    location: (location || '').trim(),
    deathPlace: (deathPlace || '').trim(),
    occupation: (occupation || '').trim(),
    photoUrl: photoUrl ?? null,
    updatedAt: serverTimestamp(),
  });
}

// Adds a relationship between two existing people. `type` is from the
// child's perspective of the action taken in the UI:
//   'parent'  — relatedId becomes a parent of personId
//   'child'   — relatedId becomes a child of personId
//   'spouse'  — personId and relatedId become spouses (status applies to both)
//   'sibling' — personId and relatedId become siblings
export async function addRelationship(type, personId, relatedId, status) {
  await authReady;
  if (type === 'parent') {
    await arrayAddUnique(personId, 'parentIds', relatedId);
  } else if (type === 'child') {
    await arrayAddUnique(relatedId, 'parentIds', personId);
  } else if (type === 'sibling') {
    await arrayAddUnique(personId, 'siblingIds', relatedId);
    await arrayAddUnique(relatedId, 'siblingIds', personId);
  } else if (type === 'spouse') {
    await addSpouseLink(personId, relatedId, status || 'current');
  }
}

export async function removeRelationship(type, personId, relatedId) {
  await authReady;
  if (type === 'parent') {
    await arrayRemoveValue(personId, 'parentIds', relatedId);
  } else if (type === 'sibling') {
    await arrayRemoveValue(personId, 'siblingIds', relatedId);
    await arrayRemoveValue(relatedId, 'siblingIds', personId);
  } else if (type === 'spouse') {
    await removeSpouseLink(personId, relatedId);
  }
}

async function arrayAddUnique(id, field, value) {
  const ref = doc(peopleCol, id);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.data()?.[field] || [];
    if (!current.includes(value)) {
      tx.update(ref, { [field]: [...current, value], updatedAt: serverTimestamp() });
    }
  });
}

async function arrayRemoveValue(id, field, value) {
  const ref = doc(peopleCol, id);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.data()?.[field] || [];
    tx.update(ref, { [field]: current.filter((v) => v !== value), updatedAt: serverTimestamp() });
  });
}

async function addSpouseLink(personId, relatedId, status) {
  const refA = doc(peopleCol, personId);
  const refB = doc(peopleCol, relatedId);
  await runTransaction(db, async (tx) => {
    const [snapA, snapB] = [await tx.get(refA), await tx.get(refB)];
    const spousesA = (snapA.data()?.spouses || []).filter((s) => s.id !== relatedId);
    const spousesB = (snapB.data()?.spouses || []).filter((s) => s.id !== personId);
    tx.update(refA, { spouses: [...spousesA, { id: relatedId, status }], updatedAt: serverTimestamp() });
    tx.update(refB, { spouses: [...spousesB, { id: personId, status }], updatedAt: serverTimestamp() });
  });
}

async function removeSpouseLink(personId, relatedId) {
  const refA = doc(peopleCol, personId);
  const refB = doc(peopleCol, relatedId);
  await runTransaction(db, async (tx) => {
    const [snapA, snapB] = [await tx.get(refA), await tx.get(refB)];
    const spousesA = (snapA.data()?.spouses || []).filter((s) => s.id !== relatedId);
    const spousesB = (snapB.data()?.spouses || []).filter((s) => s.id !== personId);
    tx.update(refA, { spouses: spousesA, updatedAt: serverTimestamp() });
    tx.update(refB, { spouses: spousesB, updatedAt: serverTimestamp() });
  });
}

// Deletes a person and strips every reference to them from the rest of
// the tree. Returns a snapshot of everything touched so the caller can
// offer an "undo" that restores it verbatim.
export async function deletePersonWithCleanup(id, allPeople) {
  await authReady;
  const deletedDoc = await getDoc(doc(peopleCol, id));
  const deletedData = { id, ...deletedDoc.data() };

  const touched = [];
  for (const p of allPeople) {
    if (p.id === id) continue;
    const hadParent = p.parentIds?.includes(id);
    const hadSibling = p.siblingIds?.includes(id);
    const hadSpouse = p.spouses?.some((s) => s.id === id);
    if (hadParent || hadSibling || hadSpouse) {
      touched.push({
        id: p.id,
        parentIds: p.parentIds || [],
        siblingIds: p.siblingIds || [],
        spouses: p.spouses || [],
      });
    }
  }

  for (const p of touched) {
    await updateDoc(doc(peopleCol, p.id), {
      parentIds: p.parentIds.filter((v) => v !== id),
      siblingIds: p.siblingIds.filter((v) => v !== id),
      spouses: p.spouses.filter((s) => s.id !== id),
      updatedAt: serverTimestamp(),
    });
  }

  await deleteDoc(doc(peopleCol, id));

  return { deletedData, touched };
}

export async function undoDelete({ deletedData, touched }) {
  await authReady;
  const { id, ...data } = deletedData;
  await setDoc(doc(peopleCol, id), data);
  for (const p of touched) {
    await updateDoc(doc(peopleCol, p.id), {
      parentIds: p.parentIds,
      siblingIds: p.siblingIds,
      spouses: p.spouses,
      updatedAt: serverTimestamp(),
    });
  }
}
