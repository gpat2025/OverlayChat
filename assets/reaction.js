import {
  db,
  isFirebaseConfigured,
  onValue,
  roomRef
} from "./firebase.js";
import {
  getRoomId,
  setHidden
} from "./shared.js";

const roomId = getRoomId();
const reactionOverlay = document.querySelector("#reactionOverlay");
const reactionGif = document.querySelector("#reactionGif");
const reactionSender = document.querySelector("#reactionSender");

// Tracking to avoid repeated shows
let lastReactionTimestamp = 0;
let reactionTimer = null;

if (!isFirebaseConfigured || !db) {
  console.warn("Firebase not configured for Reaction Window");
} else {
  onValue(roomRef(roomId, "reaction"), (snapshot) => {
    const data = snapshot.val();
    if (!data || !data.url || !data.timestamp) return;

    // Only show if it's a new reaction (avoid re-triggering on initial load or duplicates)
    if (data.timestamp <= lastReactionTimestamp) return;
    lastReactionTimestamp = data.timestamp;

    // Check if the reaction is relatively fresh (e.g. within last 30 seconds)
    const now = Date.now();
    const serverTime = data.timestamp;
    if (now - serverTime > 30000) return;

    showReaction(data);
  });

  const showReaction = (data) => {
    // Clear existing timer if any
    if (reactionTimer) {
      clearTimeout(reactionTimer);
    }

    // Update content and show
    reactionGif.src = data.url;
    reactionSender.textContent = data.senderName || "Anonymous";
    
    setHidden(reactionOverlay, false);
    reactionOverlay.classList.remove("fade-out");
    reactionOverlay.classList.add("fade-in");

    // Auto-hide after 20 seconds
    reactionTimer = setTimeout(() => {
      reactionOverlay.classList.remove("fade-in");
      reactionOverlay.classList.add("fade-out");
      
      // Wait for animation to finish before hiding
      setTimeout(() => {
        if (reactionOverlay.classList.contains("fade-out")) {
          setHidden(reactionOverlay, true);
        }
      }, 500); 
    }, 20000);
  };
}
