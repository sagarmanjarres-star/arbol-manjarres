// Picks the real Firestore-backed store, or the localStorage mock when
// the page is opened with ?mock=1 (for local testing without touching
// the live family tree). Both modules export the same function names.

const useMock = new URLSearchParams(location.search).has('mock');
const impl = useMock
  ? await import('./people-store.mock.js')
  : await import('./people-store.js');

export const {
  subscribePeople,
  addPerson,
  updatePersonDetails,
  addRelationship,
  removeRelationship,
  deletePersonWithCleanup,
  undoDelete,
} = impl;
