// Firebase setup, loaded as an ES module (via CDN URLs — no npm/bundler
// needed, matching the rest of this project's "no build step" approach).
// This file's only job right now is: connect, sign in anonymously, and run
// one write+read against Firestore to prove the whole pipeline works. The
// real match-syncing data model comes in a later step, on top of this.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCsha5WmczqC9pEKIetcwgKIrd9-pj1xoM",
  authDomain: "sabotage-mahjong.firebaseapp.com",
  projectId: "sabotage-mahjong",
  storageBucket: "sabotage-mahjong.firebasestorage.app",
  messagingSenderId: "546247732333",
  appId: "1:546247732333:web:5f634eeedaff6048e56364",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// authReady resolves once with this browser's anonymous uid. Other modules
// (matchmaking.js) await window.fb.authReady instead of racing
// onAuthStateChanged themselves.
const authReady = signInAnonymously(auth).then((cred) => cred.user.uid);

// main.js is a plain (non-module) script, so it can't `import` this file —
// stashing these on window is the simplest bridge until/unless the whole
// project moves to ES modules.
window.fb = { app, db, auth, authReady };

const statusEl = document.getElementById('firebase-status');

function setStatus(text, ok) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('ok', ok === true);
  statusEl.classList.toggle('error', ok === false);
}

// matchmaking.js reuses this same status line to surface mid-match sync
// problems (dropped connection, permission errors) — otherwise those fail
// silently in the console and the player has no idea anything is wrong.
window.fb = window.fb || {};
window.fb.setStatus = setStatus;

async function testConnection() {
  setStatus('Firebase: conectando…', null);
  try {
    const uid = await authReady;

    const testRef = doc(db, 'connection-test', uid);
    await setDoc(testRef, { uid, checkedAt: serverTimestamp() });

    const snap = await getDoc(testRef);
    if (!snap.exists()) throw new Error('Se escribió el documento pero no se pudo leer de vuelta.');

    setStatus(`Firebase: conectado (uid ${uid.slice(0, 6)}…)`, true);
    console.log('[firebase-init] connection test passed', snap.data());
  } catch (err) {
    setStatus(`Firebase: error — ${err.message}`, false);
    console.error('[firebase-init] connection test failed', err);
  }
}

testConnection();
