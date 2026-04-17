import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  get,
  limitToLast,
  onValue,
  push,
  query,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

let db = null;

if (isFirebaseConfigured) {
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);
}

export { db, isFirebaseConfigured, onValue, query, limitToLast, ref, get, set };

const roomPath = (roomId, child = "") =>
  child ? `rooms/${roomId}/${child}` : `rooms/${roomId}`;

export const roomRef = (roomId, child = "") => {
  if (!db) {
    throw new Error("Firebase is not configured");
  }

  return ref(db, roomPath(roomId, child));
};

export const getOnce = async (ref) => {
  return await get(ref);
};

export const savePrediction = async (roomId, clientId, payload) => {
  const ts = serverTimestamp();
  
  // 1. Update the current active prediction
  await set(roomRef(roomId, `predictions/${clientId}`), {
    ...payload,
    updatedAt: ts,
  });

  // 2. Append to match-specific audit trail for this user
  // We use the match title as a sub-folder to keep it organized. 
  // We must sanitize it to remove illegal Firebase path characters (#, ., $, [, ])
  const rawMatchId = payload.matchId || "unknown_match";
  const safeMatchId = rawMatchId.replace(/[.#$[\]]/g, "_");
  
  const historyRef = roomRef(roomId, `prediction_history/${clientId}/${safeMatchId}`);
  await set(push(historyRef), {
    ...payload,
    loggedAt: ts
  });
};

export const sendChatMessage = async (roomId, payload) => {
  const chatRef = roomRef(roomId, "chat");
  const nextRef = push(chatRef);
  await set(nextRef, {
    ...payload,
    createdAt: serverTimestamp(),
  });
};

export const saveRoomMeta = async (roomId, payload) => {
  await update(roomRef(roomId, "meta"), {
    ...payload,
    updatedAt: serverTimestamp(),
  });
};

export const clearRoomNode = async (roomId, child) => {
  await remove(roomRef(roomId, child));
};

export const saveInningsHistory = async (roomId, innings, results) => {
  await set(roomRef(roomId, `innings_history/${innings}`), results);
};

export const getInningsHistory = async (roomId) => {
  const snapshot = await get(roomRef(roomId, "innings_history"));
  return snapshot.val() || {};
};

export const archiveToHistory = async (roomId, dateKey, data) => {
  await set(roomRef(roomId, `history/${dateKey}`), {
    ...data,
    archivedAt: serverTimestamp()
  });
};

export const getHistory = async (roomId) => {
  const snapshot = await get(roomRef(roomId, "history"));
  return snapshot.val() || {};
};

export const wipeMatchData = async (roomId) => {
  await remove(roomRef(roomId, "predictions"));
  await remove(roomRef(roomId, "innings_history"));
  await update(roomRef(roomId, "meta"), {
    matchTitle: "",
    teamA: "",
    teamB: "",
    predictionsPaused: false,
    secondInnings: false,
    disableScoreA: false,
    disableScoreB: false,
    updatedAt: serverTimestamp()
  });
};

export const saveSeasonLeaderboard = async (roomId, data) => {
  await set(roomRef(roomId, "season_leaderboard"), {
    standings: data,
    updatedAt: serverTimestamp()
  });
};

export const removePrediction = async (roomId, clientId) => {
  await set(roomRef(roomId, `predictions/${clientId}`), null);
};

export const removeChatMessage = async (roomId, messageId) => {
  await set(roomRef(roomId, `chat/${messageId}`), null);
};

export const updateActiveSession = async (roomId) => {
  if (!db) return;
  await set(ref(db, `active_sessions/${roomId}`), {
    lastActive: serverTimestamp()
  });
};

export const sendReaction = async (roomId, payload) => {
  const reactionRef = roomRef(roomId, "reaction");
  await set(reactionRef, {
    ...payload,
    timestamp: serverTimestamp()
  });
};
