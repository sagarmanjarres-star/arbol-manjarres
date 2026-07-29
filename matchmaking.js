// Room creation/joining, plus the actual board sync once two players are in
// a room. A "match" doc looks like:
//
//   matches/{roomId} = {
//     createdAt, shapeId,
//     players: { [uid]: { role: 'p1'|'p2', joinedAt } },
//     boards: {
//       p1: { deck, removedIds, trayIds, frozenUntil, hiddenUntil, charges, wins, pendingEffect },
//       p2: { ...same shape... },
//     },
//   }
//
// Each client only ever writes its own `boards.{myRole}` slot in full. The
// one exception is sending a power-up: that writes just the narrow
// `boards.{otherRole}.pendingEffect` field — a "mailbox" the target's own
// client reads, applies to its own authoritative board, and clears by
// moving on (no ack needed; effects are simple enough to just re-derive).
//
// State sync is a plain periodic push rather than push-on-every-change —
// far simpler, and one write every ~500ms per player is nothing for
// Firestore's free tier in a casual 1v1 game.

import {
  doc,
  setDoc,
  updateDoc,
  getDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const { db, authReady } = window.fb;
const bridge = window.remoteBridge;

let currentUid = null;
let unsubscribeMatch = null;

let roomId = null;
let myRole = null;
let otherRole = null;
let shapeId = null;
let matchStarted = false;
let haveOpponentDeck = false;
let lastProcessedEffectId = null;
let pushIntervalId = null;
let syncBroken = false; // true while pushes/listener are failing — drives the visible status line

function setSyncStatus(text, ok) {
  if (window.fb.setStatus) window.fb.setStatus(text, ok);
}

function reportSyncError(context, err) {
  syncBroken = true;
  console.error(`[matchmaking] ${context}`, err);
  setSyncStatus(`Conexión inestable (${context}): ${err.message} — revisa tu red o la hora del sistema.`, false);
}

function reportSyncOk() {
  if (!syncBroken) return;
  syncBroken = false;
  setSyncStatus('Firebase: conectado — sincronizando', true);
}

const createBtn = document.getElementById('create-match');
const joinBtn = document.getElementById('join-match');
const roomCodeInput = document.getElementById('room-code-input');
const roomInfoEl = document.getElementById('room-info');
const roomErrorEl = document.getElementById('room-error');

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)

function randomRoomCode(length = 5) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function setError(text) {
  roomErrorEl.textContent = text;
}

function renderRoomStatus(id, playerCount) {
  roomErrorEl.textContent = '';
  if (playerCount >= 2) {
    roomInfoEl.textContent = `Sala ${id} — ¡los dos jugadores están conectados!`;
    roomInfoEl.classList.add('ready');
  } else {
    roomInfoEl.textContent = `Sala ${id} — esperando al otro jugador… comparte este código.`;
    roomInfoEl.classList.remove('ready');
  }
}

function matchDocRef() {
  return doc(db, 'matches', roomId);
}

function myBoardFieldPath(field) {
  return `boards.${myRole}.${field}`;
}

// One-time deal: create my own random board for this shape and publish its
// deck so the opponent's client can mirror it exactly.
function startOnlineMatch() {
  matchStarted = true;
  bridge.lockToOnlineMatch();

  bridge.players.you.board = new MahjongBoard(shapeId);
  bridge.players.you.selectedId = null;
  bridge.players.you.charges = Object.fromEntries(POWERUP_DEFS.map((d) => [d.id, 0]));
  bridge.players.you.clearProgress = 0;
  bridge.players.you.wins = 0;
  bridge.players.you.hasCountedWin = false;

  bridge.players.opp.isRemote = true;
  bridge.players.opp.board = new MahjongBoard(shapeId); // placeholder until the real deck arrives
  bridge.players.opp.wins = 0;

  bridge.sendEffect = (powerupId, fromName) => {
    updateDoc(matchDocRef(), {
      [`boards.${otherRole}.pendingEffect`]: { id: `${Date.now()}-${Math.random()}`, powerupId, fromName },
    }).catch((err) => console.error('[matchmaking] failed to send effect', err));
  };

  pushMyState({
    deck: bridge.players.you.board.getDeck(),
    charges: bridge.players.you.charges,
    wins: bridge.players.you.wins,
  });

  pushIntervalId = setInterval(() => pushMyState(), 500);
  bridge.renderAll();
}

function pushMyState(extra = {}) {
  if (!matchStarted) return;
  const state = bridge.players.you.board.serializeState();
  updateDoc(matchDocRef(), {
    [myBoardFieldPath('removedIds')]: state.removedIds,
    [myBoardFieldPath('trayIds')]: state.trayIds,
    [myBoardFieldPath('frozenUntil')]: state.frozenUntil,
    [myBoardFieldPath('hiddenUntil')]: state.hiddenUntil,
    [myBoardFieldPath('charges')]: bridge.players.you.charges,
    [myBoardFieldPath('wins')]: bridge.players.you.wins,
    [myBoardFieldPath('displayName')]: bridge.nameFor('you'),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [myBoardFieldPath(k), v])),
  }).then(reportSyncOk)
    .catch((err) => reportSyncError('envío de tu jugada', err));
}

function handleOpponentUpdate(oppData) {
  if (!oppData) return;
  const opp = bridge.players.opp;

  if (oppData.deck && !haveOpponentDeck) {
    haveOpponentDeck = true;
    opp.board = new MahjongBoard(shapeId, oppData.deck);
  }
  if (!haveOpponentDeck) return; // nothing sensible to mirror yet

  opp.board.applyRemoteState(oppData);
  if (oppData.charges) opp.charges = oppData.charges;
  if (typeof oppData.wins === 'number') opp.wins = oppData.wins;
  if (oppData.displayName) opp.nameInputEl.value = oppData.displayName;

  // Opponent has no rendered board anymore — just the name/count/wins strip.
  bridge.renderOppStatus();
  // Their board is a full mirror of the real remote state, so isWon()/
  // hasMovesLeft() here are authoritative — this is how "they won" reaches
  // your screen at all, since nothing local ever triggers it otherwise.
  bridge.checkEndState('opp');
}

function handleIncomingEffect(myData) {
  const effect = myData && myData.pendingEffect;
  if (!effect || effect.id === lastProcessedEffectId) return;
  lastProcessedEffectId = effect.id;

  const applied = applyPowerup(effect.powerupId, bridge.players.you.board);
  bridge.renderBoard('you');
  if (applied) {
    bridge.flashMessage('you', bridge.attackMessageFor(effect.fromName, effect.powerupId));
  }
  pushMyState(); // let them see the effect land without waiting for the next tick
}

function subscribeToMatch() {
  if (unsubscribeMatch) unsubscribeMatch();
  unsubscribeMatch = onSnapshot(
    doc(db, 'matches', roomId),
    (snap) => {
      reportSyncOk();
      if (!snap.exists()) return;
      const data = snap.data();
      const playersMap = data.players || {};
      renderRoomStatus(roomId, Object.keys(playersMap).length);

      if (!myRole) {
        const mine = playersMap[currentUid];
        if (!mine) return;
        myRole = mine.role;
        otherRole = myRole === 'p1' ? 'p2' : 'p1';
        shapeId = data.shapeId;
      }

      if (!matchStarted && Object.keys(playersMap).length >= 2) {
        startOnlineMatch();
      }
      if (matchStarted) {
        handleOpponentUpdate(data.boards && data.boards[otherRole]);
        handleIncomingEffect(data.boards && data.boards[myRole]);
      }
    },
    // Without this, a dropped/denied listener fails completely silently —
    // "waiting for opponent" or "waiting for their move" just hangs forever
    // with zero on-screen indication anything is wrong.
    (err) => reportSyncError('conexión con la sala', err)
  );
}

async function createMatch() {
  setError('');
  roomId = randomRoomCode();
  await setDoc(doc(db, 'matches', roomId), {
    createdAt: serverTimestamp(),
    shapeId: shapeSelectEl.value,
    players: { [currentUid]: { role: 'p1', joinedAt: serverTimestamp() } },
  });
  subscribeToMatch();
}

async function joinMatch(id) {
  setError('');
  if (!id) {
    setError('Escribe un código de sala.');
    return;
  }
  const ref = doc(db, 'matches', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    setError('Esa sala no existe.');
    return;
  }
  const playersMap = snap.data().players || {};
  const uids = Object.keys(playersMap);
  if (!uids.includes(currentUid)) {
    if (uids.length >= 2) {
      setError('Esa sala ya tiene dos jugadores.');
      return;
    }
    await updateDoc(ref, {
      [`players.${currentUid}`]: { role: 'p2', joinedAt: serverTimestamp() },
    });
  }
  roomId = id;
  subscribeToMatch();
}

authReady.then((uid) => {
  currentUid = uid;
  createBtn.disabled = false;
  joinBtn.disabled = false;
});

createBtn.addEventListener('click', () => createMatch().catch((err) => setError(err.message)));
joinBtn.addEventListener('click', () => {
  joinMatch(roomCodeInput.value.trim().toUpperCase()).catch((err) => setError(err.message));
});
