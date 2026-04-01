import { db, onValue, roomRef, query, limitToLast } from "./firebase.js";
import { getRoomId, escapeHtml, applyTeamTheme } from "./shared.js";

const roomId = getRoomId();
const tickerContent = document.getElementById("tickerContent");

let currentMessages = []; // Array of { id, user, text, timestamp }
let currentPredictions = []; // Array of { id, name, scoreA, scoreB, winner }
let currentMeta = {};
let currentPredictionsCount = 0;

// 1 minute expiration (60,000ms)
const MESSAGE_EXPIRY = 60000;

/**
 * Updates the ticker DOM content and calculates scrolling duration
 */
const updateTickerDOM = () => {
  const now = Date.now();
  // Filter messages based on time (1 min threshold)
  const validMessages = currentMessages.filter(msg => (now - msg.timestamp) < MESSAGE_EXPIRY);

  const items = [];

  // 1. Prediction Global Summary
  if (currentMeta.teamA && currentMeta.teamB) {
    const pA = currentMeta.percentA !== undefined ? currentMeta.percentA : 50;
    const pB = currentMeta.percentB !== undefined ? currentMeta.percentB : 50;
    const liveStats = `Predictions: ${currentMeta.teamA} ${pA}% vs ${currentMeta.teamB} ${pB}% (${currentPredictionsCount} votes)`;
    items.push(`
      <span class="ticker-item prediction">
        <span class="ticker-badge">Match</span>
        <span>${escapeHtml(liveStats)}</span>
      </span>
    `);
  }

  // 1b. Fan Predictions (Grouped)
  if (currentPredictions.length > 0) {
    const is2ndInnings = Boolean(currentMeta.secondInnings);
    const teamA = (currentMeta.teamA || "Home Team").toString().trim();
    const teamB = (currentMeta.teamB || "Away Team").toString().trim();
    const lowA = teamA.toLowerCase();
    const lowB = teamB.toLowerCase();

    // Infer chasing team for 2nd innings filtering
    let chasingTeam = null;
    if (is2ndInnings) {
      if (currentMeta.disableScoreA && !currentMeta.disableScoreB) chasingTeam = teamB;
      else if (currentMeta.disableScoreB && !currentMeta.disableScoreA) chasingTeam = teamA;
    }
    const lowChaser = (chasingTeam || "").toLowerCase();
    
    // Sort predictions if requested
    const sortedPredictions = [...currentPredictions].sort((a, b) => {
      if (currentMeta.predictionSort !== "score") return 0;
      
      const getValue = (p) => {
        const is2ndInnings = Boolean(currentMeta.secondInnings);
        const teamA = (currentMeta.teamA || "Home Team").toString().trim();
        const teamB = (currentMeta.teamB || "Away Team").toString().trim();
        
        let chasingTeam = null;
        if (is2ndInnings) {
          if (currentMeta.disableScoreA && !currentMeta.disableScoreB) chasingTeam = teamB;
          else if (currentMeta.disableScoreB && !currentMeta.disableScoreA) chasingTeam = teamA;
        }

        let val = 0;
        if (is2ndInnings && chasingTeam) {
          // In 2nd innings, use the chasing team's field
          const lowChaser = chasingTeam.toLowerCase();
          const lowA = teamA.toLowerCase();
          if (lowChaser === lowA) val = Number(p.scoreA) || 0;
          else val = Number(p.scoreB) || 0;
        } else {
          // 1st Innings logic
          const hasA = !currentMeta.disableScoreA;
          const hasB = !currentMeta.disableScoreB;
          
          if (hasA && !hasB) {
            val = Number(p.scoreA) || 0;
          } else if (hasB && !hasA) {
            val = Number(p.scoreB) || 0;
          } else {
            // Both active or both disabled: use predicted winner's score
            const winner = (p.winner || "").toString().trim().toLowerCase();
            const lowA = teamA.toLowerCase();
            const lowB = teamB.toLowerCase();
            
            if (winner === lowA) val = Number(p.scoreA) || 0;
            else if (winner === lowB) val = Number(p.scoreB) || 0;
            else val = Math.max(Number(p.scoreA) || 0, Number(p.scoreB) || 0);
          }
        }

        return val === 0 ? Infinity : val;
      };
      
      const valA = getValue(a);
      const valB = getValue(b);
      return valA - valB;
    });

    const fanParts = sortedPredictions
      .map((p) => {
        const predictedWinnerOrig = (p.winner || "Undecided").toString().trim();
        const predictedWinnerLow = predictedWinnerOrig.toLowerCase();
        const isChasingWinner = lowChaser && predictedWinnerLow === lowChaser;

        const detailParts = [];
        
        // Helper to check if we should display this score
        // Requirements: 
        // 1. Skip non-chaser predictions in 2nd innings
        // 2. Hide 0 or 0.0 scores/overs
        const shouldShow = (score, isTeamChaser) => {
          const num = Number(score) || 0;
          if (num <= 0) return false;
          if (is2ndInnings) return isTeamChaser;
          return true;
        };

        if (!currentMeta.disableScoreA && shouldShow(p.scoreA, lowChaser === lowA)) {
          const isAChaser = lowChaser === lowA;
          const isOver = is2ndInnings && isAChaser && isChasingWinner;
          const suffix = isOver ? " ov" : "";
          const displayVal = isOver ? (Number(p.scoreA) || 0).toFixed(1) : p.scoreA;
          detailParts.push(`${displayVal}${suffix}`);
        }
        if (!currentMeta.disableScoreB && shouldShow(p.scoreB, lowChaser === lowB)) {
          const isBChaser = lowChaser === lowB;
          const isOver = is2ndInnings && isBChaser && isChasingWinner;
          const suffix = isOver ? " ov" : "";
          const displayVal = isOver ? (Number(p.scoreB) || 0).toFixed(1) : p.scoreB;
          detailParts.push(`${displayVal}${suffix}`);
        }

        if (detailParts.length === 0) return null;
        
        return `${p.name} (${predictedWinnerOrig}): ${detailParts.join(" - ")}`;
      })
      .filter(Boolean);

    items.push(`
      <span class="ticker-item fan-prediction">
        <span class="ticker-badge">Fan Guesses</span>
        <span>${escapeHtml(fanParts.join(' | '))}</span>
      </span>
    `);
  }

  // 2. Recent Messages (Recent 1 min)
  validMessages.forEach(msg => {
    items.push(`
      <span class="ticker-item message">
        <span class="ticker-badge">Chat</span>
        <strong>${escapeHtml(msg.user)}:</strong>
        <span>${escapeHtml(msg.text)}</span>
      </span>
    `);
  });

  // Fallback if empty
  if (items.length === 0) {
    items.push(`
      <span class="ticker-item meta">
        <span class="ticker-badge">Live</span>
        <span>${currentMeta.matchTitle || "OverlayChat"} is live! Waiting for predictions/messages...</span>
      </span>
    `);
  }

  // Inject content
  const htmlContent = items.join('<span class="ticker-sep">•</span>');
  
  // To make it infinite/smooth, we can duplicate the items if it's too short
  // but for now, we'll just set it.
  tickerContent.innerHTML = htmlContent;

  // Calculate dynamic duration: longer text = slower scroll to keep speed readable
  const textLength = tickerContent.innerText.length;
  const speedFactor = 7; // Lower is slower (chars per second)
  const duration = Math.max(25, textLength / speedFactor);
  tickerContent.style.animationDuration = `${duration}s`;
};

// --- DATA CONNECTORS ---

// 1. Meta (Room Settings)
onValue(roomRef(roomId, "meta"), (snapshot) => {
  currentMeta = snapshot.val() || {};
  if (currentMeta.teamA && currentMeta.teamB) {
    applyTeamTheme(currentMeta.teamA, currentMeta.teamB);
  }
  updateTickerDOM();
});

// 2. Predictions (Stats)
onValue(roomRef(roomId, "predictions"), (snapshot) => {
  const data = snapshot.val() || {};
  currentPredictions = Object.entries(data).map(([id, p]) => ({
    id,
    name: p.name || "Guest",
    scoreA: p.scoreA || 0,
    scoreB: p.scoreB || 0,
    winner: p.predictedWinner
  }));
  currentPredictionsCount = currentPredictions.length;
  
  if (currentPredictionsCount > 0 && currentMeta.teamA) {
    const countA = currentPredictions.filter(p => p.winner === currentMeta.teamA).length;
    currentMeta.percentA = Math.round((countA / currentPredictionsCount) * 100);
    currentMeta.percentB = 100 - currentMeta.percentA;
  }
  updateTickerDOM();
});

// 3. Chat (Latest Messages)
const chatQuery = query(roomRef(roomId, "chat"), limitToLast(15));
onValue(chatQuery, (snapshot) => {
  const data = snapshot.val() || {};
  const now = Date.now();
  currentMessages = Object.entries(data)
    .map(([id, msg]) => ({
      id,
      user: msg.name || "Guest",
      text: msg.message,
      timestamp: msg.createdAt || now
    }))
    .sort((a, b) => b.timestamp - a.timestamp); // Keep order consistent
  
  updateTickerDOM();
});

// 4. Maintenance (Pruning)
// Refresh every 10 seconds to remove expired messages even if no activity occurs
setInterval(updateTickerDOM, 10000);
