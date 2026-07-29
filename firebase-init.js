// Firebase setup, loaded as an ES module via CDN URLs — no npm/bundler,
// same "no build step" approach as the Sabotage Mahjong project.
//
// There is no login screen: every visitor signs in anonymously the moment
// the page loads. This isn't a security boundary, it just gives Firestore
// rules an auth token to check against.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDOSM6AlQiOBn7b4CqbAHcZilx6RIXKSvc",
  authDomain: "family-tree-5baeb.firebaseapp.com",
  projectId: "family-tree-5baeb",
  storageBucket: "family-tree-5baeb.firebasestorage.app",
  messagingSenderId: "964079596841",
  appId: "1:964079596841:web:3840fbd4c1c7ed4b57b338",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
const auth = getAuth(app);

export const authReady = signInAnonymously(auth).then((cred) => cred.user.uid);
