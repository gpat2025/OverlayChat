import {
  db,
  isFirebaseConfigured,
  limitToLast,
  onValue,
  query,
  roomRef,
  savePrediction,
  sendChatMessage,
  sendReaction,
  ref
} from "./firebase.js";
import {
  escapeHtml,
  formatWinnerCounts,
  getClientId,
  getRememberedViewerName,
  getRoomId,
  hasExplicitRoomCode,
  rememberViewerName,
  setHidden,
  sortByTimestampAscending,
  applyTeamTheme,
  stripKlipyUrl,
  sortHistoryLatestFirst
} from "./shared.js";
import { renderPlayerProfile, renderPlayerListModal } from "./visualize_data.js?v=3";

const roomId = getRoomId();
const clientId = getClientId();
const roomSelected = hasExplicitRoomCode();

// Global State
let localStandings = [];
let localHistory = {};
let seasonSortMode = "total"; // "total", "ppg", "avg"
let returnToPlayerName = null; // Track source for "Back" button safe navigation
let existingWinner = "";
let existingPenalty = 0;


const audienceGate = document.querySelector("#audienceGate");
const audienceApp = document.querySelector("#audienceApp");
const roomJoinForm = document.querySelector("#roomJoinForm");
const roomCodeInput = document.querySelector("#roomCode");
const roomBadge = document.querySelector("#roomBadge");
const matchBadge = document.querySelector("#matchBadge");
const setupNotice = document.querySelector("#setupNotice");
const predictionForm = document.querySelector("#predictionForm");
const chatForm = document.querySelector("#chatForm");
const viewerNameInput = document.querySelector("#viewerName");
const predictedWinnerInput = document.querySelector("#predictedWinner");
const scoreAInput = document.querySelector("#scoreA");
const scoreBInput = document.querySelector("#scoreB");
const labelScoreA = document.querySelector("#labelScoreA");
const labelScoreB = document.querySelector("#labelScoreB");
const chatMessageInput = document.querySelector("#chatMessage");
const chatFeed = document.querySelector("#chatFeed");
const predictionStatus = document.querySelector("#predictionStatus");
const chatStatus = document.querySelector("#chatStatus");
const predictionSubmitButton = predictionForm?.querySelector("button[type='submit']");
const restoreSessionBtn = document.querySelector("#restoreSessionBtn");

const activeDiscovery = document.querySelector("#activeDiscovery");
const activeSessionsList = document.querySelector("#activeSessionsList");

// Integrated GIF Picker UI
const toggleGifPickerBtn = document.querySelector("#toggleGifPicker");
const gifPickerContainer = document.querySelector("#gifPicker");
const pickerSearchBox = document.querySelector("#pickerSearchBox");
const tabBtns = document.querySelectorAll(".tab-btn");
const gifSearchInput = document.querySelector("#gifSearch");
const gifGrid = document.querySelector("#gifGrid");
const reactionStatus = document.querySelector("#reactionStatus"); // Fallback for logs

// Leaderboard UI
const viewStatsListBtn = document.querySelector("#viewStatsList");
const viewLeaderboardBtn = document.querySelector("#viewLeaderboard");
const closeLeaderboardBtn = document.querySelector("#closeLeaderboard");
const leaderboardModal = document.querySelector("#leaderboardModal");
const leaderboardList = document.querySelector("#leaderboardList");

// Daily Updates UI
const seasonView = document.querySelector("#seasonView");
const dailyView = document.querySelector("#dailyView");
const matchDetailView = document.querySelector("#matchDetailView");
const historyListContainer = document.querySelector("#historyList");
const matchDetailList = document.querySelector("#matchDetailList");
const matchDetailTitle = document.querySelector("#matchDetailTitle");
const backToDailyBtn = document.querySelector("#backToDailyBtn");
const modalNavTabs = document.querySelectorAll(".modal-nav-tab");

let activePredictions = {};
let liveHist1st = {};
let liveHist2nd = {};

const KLIPY_API_KEY = "rwGYYILu8ZBT9xFPoSG2jUhq65JqUbryTlm4JXs8dWXxmR5GgGbEn5nrgvNxRCud";
const KLIPY_BASE_URL = `https://api.klipy.com/api/v1`;

let predictionLocked = false;
let predictionsPaused = false;
let currentMeta = {};
let chasingTeam = null;
let isEditingReprediction = false;

const normalizeRoomCode = (value) =>
  value.toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 40);

const setPredictionInputsDisabled = (disabled, meta = {}) => {
  viewerNameInput.disabled = disabled;
  
  // Individual score controls
  const scoreADisabled = disabled || Boolean(meta.disableScoreA);
  const scoreBDisabled = disabled || Boolean(meta.disableScoreB);
  
  scoreAInput.disabled = scoreADisabled;
  scoreBInput.disabled = scoreBDisabled;
  
  // Add styling for disabled fields
  scoreAInput.parentElement.classList.toggle("field-disabled", scoreADisabled);
  scoreBInput.parentElement.classList.toggle("field-disabled", scoreBDisabled);

  predictedWinnerInput.disabled = disabled;
  predictionSubmitButton.disabled = disabled;
  predictionForm.classList.toggle("disabled", disabled);
};

const syncPredictionAccess = (meta = {}) => {
  if (predictionsPaused) {
    setPredictionInputsDisabled(true, meta);
    predictionSubmitButton.textContent = "Predictions paused";
    setStatus(predictionStatus, "Predictions paused", "danger");
    return;
  }

  if (predictionLocked && !isEditingReprediction) {
    setPredictionInputsDisabled(true, meta);
    predictionSubmitButton.textContent = "Prediction locked";
    setStatus(predictionStatus, "Prediction locked", "neutral");
    return;
  }

  setPredictionInputsDisabled(false, meta);
  predictionSubmitButton.textContent = predictionLocked
    ? (isEditingReprediction ? "Save updated prediction" : "Update prediction")
    : "Send prediction";
};

roomJoinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const nextRoom = normalizeRoomCode(roomCodeInput.value.trim());
  if (!nextRoom) {
    return;
  }

  const url = new URL(window.location.href);
  const useShortParam = url.pathname === "/" || url.pathname === "/a";
  url.search = "";
  url.searchParams.set(useShortParam ? "r" : "room", nextRoom);
  window.location.href = url.toString();
});

const setStatus = (element, text, tone = "default") => {
  element.textContent = text;
  element.classList.remove("neutral", "danger");
  if (tone !== "default") {
    element.classList.add(tone);
  }
};

const renderWinnerOptions = (meta = {}) => {
  const options = [meta.teamA, meta.teamB].filter(Boolean);
  const selected = predictedWinnerInput.value;

  predictedWinnerInput.innerHTML = `
    <option value="">Choose winner</option>
    ${options
      .map(
        (option) =>
          `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`
      )
      .join("")}
  `;

  if (options.includes(selected)) {
    predictedWinnerInput.value = selected;
  }

  predictionsPaused = Boolean(meta.predictionsPaused);
  isEditingReprediction = Boolean(meta.isEditingReprediction);

  if (meta.matchTitle) {
    matchBadge.textContent = meta.matchTitle;
  } else if (options.length === 2) {
    matchBadge.textContent = `${options[0]} vs ${options[1]}`;
  } else {
    matchBadge.textContent = "Waiting for match setup";
  }

  // Labels are managed dynamically by updateInningsLabels() — do not reset them here.

  syncPredictionAccess(meta);
};

const updateInningsLabels = () => {
  const winner = (predictedWinnerInput.value || "").toString().trim().toLowerCase();
  const teamA = (currentMeta.teamA || "").toString().trim();
  const teamB = (currentMeta.teamB || "").toString().trim();
  const is2ndInnings = Boolean(currentMeta.secondInnings);
  
  const isPreToss = teamA && teamB && !is2ndInnings && !currentMeta.disableScoreA && !currentMeta.disableScoreB;
  
  // Infer chasing team:
  // If 2nd innings is ON, the team that is NOT disabled is currently batting (chasing)
  let inferredChaser = null;
  if (is2ndInnings) {
    if (currentMeta.disableScoreA && !currentMeta.disableScoreB) inferredChaser = teamB;
    else if (currentMeta.disableScoreB && !currentMeta.disableScoreA) inferredChaser = teamA;
  }

  chasingTeam = inferredChaser;
  const lowChaser = (chasingTeam || "").toLowerCase();
  const isChasingWinner = lowChaser && winner === lowChaser;

  // Toggle single column layout if one score is hidden
  const dualRow = document.querySelector(".dual-row");
  if (dualRow) {
    const hasHidden = Boolean(currentMeta.disableScoreA) || Boolean(currentMeta.disableScoreB);
    dualRow.classList.toggle("single-col", hasHidden);
  }

  const lowA = teamA.toLowerCase();
  const lowB = teamB.toLowerCase();

  if (labelScoreA) {
    const isChaser = lowChaser === lowA;
    const isOversMode = is2ndInnings && isChaser && isChasingWinner;
    
    // Requirement: Hide score field if disabled by executive
    const isDisabled = Boolean(currentMeta.disableScoreA);
    labelScoreA.parentElement.classList.toggle("hidden", isDisabled);
    // Also disable + clear hidden inputs so residual values don't get sent to Firebase
    scoreAInput.disabled = isDisabled;
    if (isDisabled) scoreAInput.value = "";

    if (isPreToss) {
      labelScoreA.textContent = `Predict if ${teamA} bats first`;
    } else {
      labelScoreA.textContent = isOversMode ? `${teamA} Overs` : `${teamA} Score`;
    }
    
    // If it's the 2nd innings, allow decimals for both fields to be safe
    scoreAInput.step = is2ndInnings ? "any" : "1";
    scoreAInput.placeholder = isOversMode ? "e.g. 18.2" : "0";
  }
  
  if (labelScoreB) {
    const isChaser = lowChaser === lowB;
    const isOversMode = is2ndInnings && isChaser && isChasingWinner;

    // Requirement: Hide score field if disabled by executive
    const isDisabled = Boolean(currentMeta.disableScoreB);
    labelScoreB.parentElement.classList.toggle("hidden", isDisabled);
    // Also disable + clear hidden inputs so residual values don't get sent to Firebase
    scoreBInput.disabled = isDisabled;
    if (isDisabled) scoreBInput.value = "";

    if (isPreToss) {
      labelScoreB.textContent = `Predict if ${teamB} bats first`;
    } else {
      labelScoreB.textContent = isOversMode ? `${teamB} Overs` : `${teamB} Score`;
    }
    
    // If it's the 2nd innings, allow decimals for both fields to be safe
    scoreBInput.step = is2ndInnings ? "any" : "1";
    scoreBInput.placeholder = isOversMode ? "e.g. 18.2" : "0";
  }
};

predictedWinnerInput?.addEventListener("change", updateInningsLabels);
predictedWinnerInput?.addEventListener("input", updateInningsLabels);

const renderChat = (messages) => {
  if (!messages.length) {
    chatFeed.innerHTML = `<div class="empty-state">No chat yet. Be the first message.</div>`;
    return;
  }

  const filteredMessages = messages.filter(msg => {
    const stripped = stripKlipyUrl(msg.message);
    const isKlipyOnly = msg.message && !stripped && (msg.message.includes("klipy.co") || msg.message.includes("klipy.com"));
    return !isKlipyOnly;
  });

  // Find consecutive messages from the same user to group them
  const sortedMessages = sortByTimestampAscending(filteredMessages, "createdAt");
  
  // Notice: reverse() puts the newest at the top, but Slack usually has newest at bottom.
  // We'll keep the feed order as it was designed (newest at top) but just apply the styling.
  chatFeed.innerHTML = sortedMessages
    .reverse()
    .map(
      (message, idx, arr) => {
        const isGif = message.message && (message.message.startsWith("http") && (message.message.includes(".gif") || message.message.includes("klipy")));
        const displayMessage = stripKlipyUrl(message.message);
        const isKlipyOnly = message.message && !displayMessage && (message.message.includes("klipy.co") || message.message.includes("klipy.com"));
        
        const content = isGif 
          ? `<div class="chat-msg-content"><img src="${message.message}" alt="Reaction GIF" loading="lazy" /></div>`
          : `<div class="chat-msg-content"><p>${escapeHtml(displayMessage)}</p></div>`;
          
        const isOwn = message.clientId && message.clientId === clientId;
        const msgClass = isOwn ? 'own-message' : 'other-message';
        
        // Hide name if it's our own message OR if it's a Klipy-only reaction for cleaner look
        const headerHtml = (isOwn || isKlipyOnly) ? '' : `<header><strong>${escapeHtml(message.name)}</strong></header>`;

        return `
          <article class="chat-message audience-chat-message ${msgClass} ${isGif ? 'message-gif' : ''}">
            ${headerHtml}
            ${content}
          </article>
        `;
      }
    )
    .join("");

  chatFeed.scrollTop = 0;
};

if (!roomSelected) {
  setHidden(audienceGate, false);
  setHidden(audienceApp, true);
  
  if (isFirebaseConfigured && db) {
    onValue(ref(db, "active_sessions"), (snapshot) => {
      const sessions = snapshot.val() || {};
      const now = Date.now();
      const activeRooms = Object.entries(sessions)
        .filter(([_, data]) => now - (data.lastActive || 0) < 60000)
        .map(([id]) => id);

      activeSessionsList.innerHTML = activeRooms
        .map(
          (id) => `
          <button class="discovery-chip" type="button" data-room="${escapeHtml(id)}">
            <span class="pulse-dot"></span>
            <span class="chip-label">${escapeHtml(id)}</span>
          </button>
        `
        )
        .join("");

      setHidden(activeDiscovery, activeRooms.length === 0);
      
      activeSessionsList.querySelectorAll(".discovery-chip").forEach(btn => {
        btn.onclick = () => {
          const url = new URL(window.location.href);
          const useShortParam = url.pathname === "/" || url.pathname === "/a";
          url.search = "";
          url.searchParams.set(useShortParam ? "r" : "room", btn.dataset.room);
          window.location.href = url.toString();
        };
      });
    });
  }
} else {
  setHidden(audienceGate, true);
  setHidden(audienceApp, false);
  roomBadge.textContent = roomId;
  viewerNameInput.value = getRememberedViewerName();

  if (!isFirebaseConfigured || !db) {
    setHidden(setupNotice, false);
    predictionForm.classList.add("disabled");
    chatForm.classList.add("disabled");
    setStatus(predictionStatus, "Setup required", "danger");
    setStatus(chatStatus, "Setup required", "danger");
  } else {
    onValue(roomRef(roomId, "meta"), (snapshot) => {
      const meta = snapshot.val() || {};
      currentMeta = meta;
      applyTeamTheme(meta.teamA, meta.teamB);
      renderWinnerOptions(meta);
      updateInningsLabels();
    });

    // --- Season Leaderboard Listener ---
    onValue(roomRef(roomId, "season_leaderboard"), (snapshot) => {
      const data = snapshot.val();
      // Handle both direct array and wrapped object formats for safety
      const standings = Array.isArray(data) ? data : (data?.standings || []);
      renderLeaderboard(standings);
    });

    onValue(query(roomRef(roomId, "chat"), limitToLast(20)), (snapshot) => {
      const entries = snapshot.val() || {};
      const messages = Object.entries(entries).map(([id, value]) => ({
        id,
        ...value
      }));
      renderChat(messages);
    });

    onValue(roomRef(roomId, `predictions/${clientId}`), (snapshot) => {
      const prediction = snapshot.val();
      predictionLocked = Boolean(prediction);

      if (prediction) {
        setPredictionInputsDisabled(true, currentMeta);
        viewerNameInput.value = prediction.name || "";
        scoreAInput.value = (prediction.scoreA !== undefined && prediction.scoreA !== null) ? prediction.scoreA : "";
        scoreBInput.value = (prediction.scoreB !== undefined && prediction.scoreB !== null) ? prediction.scoreB : "";
        predictedWinnerInput.value = prediction.predictedWinner || "";
        existingWinner = prediction.predictedWinner || "";
        existingPenalty = prediction.penalty || 0;
        setHidden(restoreSessionBtn, true);
      } else {
        existingWinner = "";
        existingPenalty = 0;
      }
      syncPredictionAccess(currentMeta);
    });

    // --- Restore Session Logic ---
    viewerNameInput.addEventListener("input", () => {
      const nameVal = viewerNameInput.value.trim().toLowerCase();
      // Only show restore if we are NOT currently locked (new device/browser)
      if (!predictionLocked && nameVal.length > 0) {
        const match = Object.values(activePredictions).find(p => p.name && p.name.trim().toLowerCase() === nameVal);
        setHidden(restoreSessionBtn, !match);
      } else {
        setHidden(restoreSessionBtn, true);
      }
    });

    restoreSessionBtn.addEventListener("click", () => {
      const nameVal = viewerNameInput.value.trim().toLowerCase();
      const match = Object.values(activePredictions).find(p => p.name && p.name.trim().toLowerCase() === nameVal);
      if (match) {
        console.log(`[Restore] Syncing session for "${match.name}"...`);
        predictionLocked = true;
        isEditingReprediction = false;
        existingWinner = match.predictedWinner || "";
        existingPenalty = match.penalty || 0;

        // Auto-fill the form
        predictedWinnerInput.value = existingWinner;
        scoreAInput.value = (match.scoreA !== undefined && match.scoreA !== null) ? match.scoreA : "";
        scoreBInput.value = (match.scoreB !== undefined && match.scoreB !== null) ? match.scoreB : "";
        
        syncPredictionAccess(currentMeta);
        setHidden(restoreSessionBtn, true);
        setStatus(predictionStatus, "Session restored", "success");
      }
    });

    // --- History Listener ---
    onValue(roomRef(roomId, "history"), (snapshot) => {
      localHistory = snapshot.val() || {};
      if (!dailyView.classList.contains("hidden")) {
        renderHistoryList();
      }
    });

    onValue(roomRef(roomId, "innings_history/1st"), (snapshot) => {
      liveHist1st = snapshot.val() || {};
      if (!matchDetailView.classList.contains("hidden") && matchDetailTitle.dataset.matchId === "live") {
        renderMatchDetails("live");
      }
    });

    onValue(roomRef(roomId, "innings_history/2nd"), (snapshot) => {
      liveHist2nd = snapshot.val() || {};
      if (!matchDetailView.classList.contains("hidden") && matchDetailTitle.dataset.matchId === "live") {
        renderMatchDetails("live");
      }
    });

    onValue(roomRef(roomId, "predictions"), (snapshot) => {
      const rawPreds = snapshot.val() || {};
      activePredictions = rawPreds;
      
      const predictions = Object.values(rawPreds);
      const tally = formatWinnerCounts(predictions);
      const summary = Object.entries(tally)
        .map(([winner, count]) => `${winner}: ${count}`)
        .join(" | ");

      // Blind Mode check: 
      // 1. Before match starts (Over 0.0 and 1st Innings): Everyone is blind.
      // 2. During match: You are blind until you predict.
      // 3. Innings Break: You are blind for 2nd innings until you predict.
      const overVal = parseFloat(currentMeta.currentOver || "0");
      const isMatchStarted = overVal > 0 || currentMeta.secondInnings;
      const isBlind = !isMatchStarted || !predictionLocked;

      if (!predictionsPaused && (!predictionLocked || isEditingReprediction)) {
        let statusMsg = summary || "Live";
        if (isBlind) {
          statusMsg = (!isMatchStarted && predictionLocked) 
            ? "Standings hidden until match starts" 
            : "Predict to see standings";
        }
        setStatus(predictionStatus, statusMsg);
      }

      // If we are currently looking at the live match details in the modal, re-render it
      if (!matchDetailView.classList.contains("hidden") && matchDetailTitle.dataset.matchId === "live") {
        if (isBlind) {
          matchDetailList.innerHTML = `<div class="blind-notice"><h3>Predictions are blind</h3><p>${!isMatchStarted ? "Standings will be revealed once the match starts!" : "Make your prediction first to see what others guessed!"}</p></div>`;
        } else {
          renderMatchDetails("live");
        }
      }
    });
  }
}

predictionForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  // Handle 'Update' click to toggle edit mode
  if (predictionLocked && isEditingReprediction && !isEditingReprediction && !predictionsPaused) {
    isEditingReprediction = true;
    syncPredictionAccess(currentMeta);
    return;
  }

  if (!isFirebaseConfigured || !db || (predictionLocked && !isEditingReprediction) || predictionsPaused) {
    // If we're locked and not in edit mode, don't allow submission
    if (predictionLocked && !isEditingReprediction) {
      console.log("[Status] Submission blocked: Prediction is locked and not in edit mode.");
    }
    syncPredictionAccess(currentMeta);
    return;
  }

  const name = viewerNameInput.value.trim();
  const predictedWinner = predictedWinnerInput.value.trim();
  const lowWinner = predictedWinner.toLowerCase();
  const lowChaser = (currentMeta.chasingTeam || "").toLowerCase();

  // 1. Initial extraction from visible fields
  let scoreA = (scoreAInput.value !== "" && !scoreAInput.disabled) ? Number(scoreAInput.value) : null;
  let scoreB = (scoreBInput.value !== "" && !scoreBInput.disabled) ? Number(scoreBInput.value) : null;

  // 2. Specialized Overs validation for chaser
  if (lowChaser && lowWinner === lowChaser) {
    const teamA = (currentMeta.teamA || "Team A").toString().trim();
    const isAChaser = lowChaser === teamA.toLowerCase();
    const val = isAChaser ? scoreAInput.value : scoreBInput.value;
    
    if (val !== "") {
      const parts = val.split(".");
      const balls = parts.length > 1 ? parseInt(parts[1]) : 0;
      const overs = parseInt(parts[0]);
      
      if (balls > 5) {
        setStatus(predictionStatus, "Invalid overs — decimal must be .0 to .5 (balls)", "danger");
        return;
      }

      const isZero = overs === 0 && balls === 0;
      const exceedsMax = overs > 20 || (overs === 20 && balls > 0);
      if (isZero || overs < 0 || exceedsMax) {
        setStatus(predictionStatus, "Overs must be between 0.1 and 20.0", "danger");
        return;
      }

      // Final mapping for the chaser's overs
      if (isAChaser) scoreA = Number(val);
      else scoreB = Number(val);
    }
  }

  // Validate: all non-disabled fields must be filled
  const needsA = !scoreAInput.disabled && scoreA === null;
  const needsB = !scoreBInput.disabled && scoreB === null;

  if (!name || needsA || needsB || !predictedWinner) {
    setStatus(predictionStatus, "Fill required fields", "danger");
    return;
  }

  // --- Penalty Calculation ---
  let addedPenalty = 0;
  let breakdown = [];
  const over = parseFloat(currentMeta.currentOver || "0");
  const overLabel = over > 0 ? (over <= 1.0 ? "the 1st over" : (over <= 2.0 ? "the 2nd over" : "the 3rd over")) : "pre-match";
  
  // Multi-device protection: if no local prediction, check for name duplicates in other clients
  let effectiveUpdate = predictionLocked && !currentMeta.isInningsBreak;
  let useExistingWinner = existingWinner;
  let useExistingPenalty = existingPenalty;

  if (!predictionLocked && !currentMeta.isInningsBreak && over > 0) {
    // Check if this name already exists in activePredictions (from another device)
    const existingEntry = Object.values(activePredictions).find(p => p.name && p.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (existingEntry) {
      console.log(`[Security] Detected name match for "${name}" (device jump). Applying update rules.`);
      effectiveUpdate = true;
      useExistingWinner = existingEntry.predictedWinner || "";
      useExistingPenalty = existingEntry.penalty || 0;
    }
  }

  if (currentMeta.isInningsBreak) {
    addedPenalty = 0; // Encourages participation in 2nd innings
  } else {
    // 1. Entry/Update Over penalty
    if (!effectiveUpdate) {
      if (over >= 0.1 && over <= 1.0) { addedPenalty = 5; breakdown.push("-5 Entry Penalty (1st Over)"); }
      else if (over > 1.0 && over <= 2.0) { addedPenalty = 10; breakdown.push("-10 Entry Penalty (2nd Over)"); }
      else if (over > 2.0 && over <= 3.0) { addedPenalty = 15; breakdown.push("-15 Entry Penalty (3rd Over)"); }
    } else {
      if (over >= 0.1 && over <= 1.0) { addedPenalty = 5; breakdown.push("-5 Update Penalty (1st Over)"); }
      else if (over > 1.0 && over <= 2.0) { addedPenalty = 15; breakdown.push("-15 Update Penalty (2nd Over)"); }
      else if (over > 2.0 && over <= 3.0) { addedPenalty = 30; breakdown.push("-30 Update Penalty (3rd Over)"); }
    }

    // 2. Winner Change Penalty
    if (useExistingWinner && predictedWinner !== useExistingWinner) {
      addedPenalty += 20;
      breakdown.push("-20 Winner Change Penalty");
    }
  }

  // Final synchronization of existing state (handling both local locks and device jumps)
  existingPenalty = useExistingPenalty;
  existingWinner = useExistingWinner;

  if (addedPenalty > 0) {
    const totalNew = existingPenalty + addedPenalty;
    const isFirstTime = !effectiveUpdate && !predictionLocked;
    const msg = `CAUTION: This action will incur a penalty of -${addedPenalty} pts.\n\n` +
                `Reason: The game has already started and we're in ${overLabel}.\n` +
                `Breakdown: ${breakdown.join(", ")}\n\n` +
                `Your total match penalty will be -${totalNew} pts.\n\n` +
                (isFirstTime ? `Note: If you don't submit a prediction now, you won't receive ANY points for this innings.\n\n` : "") +
                `Continue?\n\n` +
                `P.S. Join early next match to avoid these penalties!`;
    if (!window.confirm(msg)) return;
  }

  rememberViewerName(name);
  setStatus(predictionStatus, "Sending...");

  try {
    const finalPenalty = existingPenalty + addedPenalty;
    await savePrediction(roomId, clientId, {
      clientId,
      name,
      scoreA,
      scoreB,
      predictedWinner,
      penalty: finalPenalty
    });
    predictionLocked = true;
    isEditingReprediction = false;
    existingWinner = predictedWinner;
    existingPenalty = finalPenalty;
    syncPredictionAccess(currentMeta);
    setStatus(predictionStatus, "Prediction locked", "neutral");
  } catch (error) {
    console.error(error);
    setStatus(predictionStatus, "Prediction failed", "danger");
  }
});

chatForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isFirebaseConfigured || !db) {
    return;
  }

  const name = viewerNameInput.value.trim() || getRememberedViewerName();
  const message = chatMessageInput.value.trim();

  if (!name || !message) {
    setStatus(chatStatus, "Add your name and message", "danger");
    return;
  }

  rememberViewerName(name);
  setStatus(chatStatus, "Sending...");

  try {
    await sendChatMessage(roomId, {
      clientId,
      name,
      message
    });
    chatMessageInput.value = "";
    setStatus(chatStatus, "Message sent", "neutral");
  } catch (error) {
    setStatus(chatStatus, "Message failed", "danger");
  }
});

chatMessageInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    chatForm?.requestSubmit();
  }
});


// --- Integrated GIF Picker Logic ---

const setReactionStatus = (text, tone = "default") => setStatus(chatStatus, text, tone);

toggleGifPickerBtn?.addEventListener("click", () => {
  const isHidden = gifPickerContainer.classList.contains("hidden");
  setHidden(gifPickerContainer, !isHidden);
  toggleGifPickerBtn.classList.toggle("active", isHidden);
  
  if (isHidden && !gifGrid.querySelector(".gif-item")) {
    loadTrending();
  }
});

let currentMediaType = 'gifs';

const handleTabSwitch = (e) => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  tabBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tab));
  
  currentMediaType = tab;
  
  const query = gifSearchInput.value.trim();
  if (query) {
    handleGifSearch();
  } else {
    loadTrending();
  }
};

tabBtns.forEach(btn => btn.addEventListener("click", handleTabSwitch));

const fetchKlipy = async (endpoint, params = {}) => {
  const url = new URL(`${KLIPY_BASE_URL}/${KLIPY_API_KEY}/${endpoint}`);
  Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
  
  console.log("Fetching Klipy:", url.toString());
  
  const response = await fetch(url);
  if (!response.ok) {
    const errorText = await response.text().catch(() => "No error details available");
    console.error("Klipy API error response:", errorText);
    throw new Error(`Klipy API error: ${response.status}`);
  }
  
  const text = await response.text();
  if (!text || text.trim() === "") {
    console.warn("Klipy API returned empty response body.");
    return { data: [] };
  }
  
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse Klipy JSON:", text.substring(0, 500));
    throw new Error("Klipy API returned invalid JSON.");
  }
};

const renderGifs = (gifs) => {
  if (!gifs || gifs.length === 0) {
    gifGrid.innerHTML = `<div class="empty-state">No GIFs found.</div>`;
    return;
  }

  gifGrid.innerHTML = gifs.map(gif => {
    // Klipy API media structures:
    // GIFs: gif.file.sm.gif.url
    // Stickers: gif.png.url or gif.webm.url
    const gifUrl = gif.file?.sm?.gif?.url || gif.file?.hd?.gif?.url || gif.files?.gif?.url || gif.png?.url || gif.webm?.url;
    if (!gifUrl) return "";
    
    return `
      <div class="gif-item" data-url="${gifUrl}" title="${escapeHtml(gif.title || "")}">
        <img src="${gifUrl}" alt="${escapeHtml(gif.title || "")}" loading="lazy" />
      </div>
    `;
  }).join("");

  // Add click listeners to gif items
  gifGrid.querySelectorAll(".gif-item").forEach(item => {
    item.onclick = async () => {
      const url = item.dataset.url;
      const name = viewerNameInput.value.trim() || getRememberedViewerName() || "Anonymous";
      
      setReactionStatus("Sending GIF...");
      try {
        // 1. Send as Overlay Reaction
        await sendReaction(roomId, {
          url,
          senderName: name
        });
        
        // 2. Send as Chat Message
        await sendChatMessage(roomId, {
          clientId,
          name,
          message: url // Detecting image URLs in renderChat
        });

        // Persistence on selection: picker remains open as per user request
        setReactionStatus("GIF Sent!", "neutral");
        setTimeout(() => setReactionStatus("Ready"), 3000);
      } catch (err) {
        console.error(err);
        setReactionStatus("Failed to send", "danger");
      }
    };
  });
};

const loadTrending = async () => {
  try {
    const data = await fetchKlipy(`${currentMediaType}/trending`, { limit: 48 });
    // Robust Klipy nesting check: can be data.data or data.data.data
    const gifs = Array.isArray(data?.data) ? data.data : (data?.data?.data || []);
    renderGifs(gifs);
  } catch (err) {
    console.error(err);
    gifGrid.innerHTML = `<div class="empty-state danger">Failed to load trending ${currentMediaType}.</div>`;
  }
};

const handleGifSearch = async () => {
  const query = gifSearchInput.value.trim();
  if (!query) {
    loadTrending();
    return;
  }

  setReactionStatus("Searching...");
  try {
    const data = await fetchKlipy(`${currentMediaType}/search`, { q: query, limit: 48 });
    // Robust Klipy nesting check: can be data.data or data.data.data
    const gifs = Array.isArray(data?.data) ? data.data : (data?.data?.data || []);
    renderGifs(gifs);
    setReactionStatus("Ready");
  } catch (err) {
    console.error(err);
    setReactionStatus("Search failed", "danger");
  }
};

let searchTimeout;
gifSearchInput?.addEventListener("input", (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    handleGifSearch();
  }, 400); // 400ms debounce
});

gifSearchInput?.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    clearTimeout(searchTimeout);
    handleGifSearch();
  }
});

// --- Leaderboard Implementation ---

const renderLeaderboard = (standings = []) => {
  localStandings = standings;
  if (!standings || standings.length === 0) {
    leaderboardList.innerHTML = `<tr><td colspan="5" class="empty-state">No rankings available yet.</td></tr>`;
    return;
  }

  // Sort based on current mode
  const sorted = [...standings].sort((a, b) => {
    if (seasonSortMode === "ppg") return b.ppg - a.ppg;
    return b.total - a.total;
  });

  leaderboardList.innerHTML = sorted.map((player, index) => {
    const rank = index + 1;
    const isTop3 = rank <= 3;
    const badgeClass = isTop3 ? `rank-badge top-${rank}` : 'rank-badge';
    const rowClass = isTop3 ? `top-row rank-${rank}` : '';

    const hasEnoughGames = (player.matchCount || 1) >= 5;
    const nameEl = hasEnoughGames 
      ? `<button class="player-name player-name-btn" data-name="${escapeHtml(player.name)}">${escapeHtml(player.name)}</button>`
      : `<span class="player-name dim-name">${escapeHtml(player.name)}</span>`;

    return `
      <tr class="${rowClass}">
        <td style="width: 60px;">
          <div class="${badgeClass}">${rank}</div>
        </td>
        <td class="player-info">
          ${nameEl}
          <span class="ppg-sublabel">${player.ppg || 0} PTS/GAME</span>
        </td>
        <td style="text-align: center; width: 80px;">
          <span>${player.matchCount || 1}</span>
        </td>
        <td style="text-align: right; width: 120px;">
          <span class="pts-val">${player.total || 0}</span>
        </td>
        <td style="text-align: right; width: 100px;">
          <span class="ppg-val">${player.ppg || 0}</span>
        </td>
      </tr>
    `;
  }).join("");
};

viewLeaderboardBtn?.addEventListener("click", () => {
  leaderboardModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
});

viewStatsListBtn?.addEventListener("click", () => {
  renderPlayerListModal(localStandings, localHistory);
});

closeLeaderboardBtn?.addEventListener("click", () => {
  leaderboardModal.classList.add("hidden");
  document.body.style.overflow = "";
});

leaderboardList?.addEventListener("click", (e) => {
  const btn = e.target.closest(".player-name-btn");
  console.log("Leaderboard list clicked. Button found?", !!btn);
  if (!btn) return;
  console.log("Opening profile for:", btn.dataset.name);
  renderPlayerProfile(btn.dataset.name, localHistory, localStandings);
});

// Tab Sorting Listeners
document.querySelectorAll(".l-tab").forEach(tab => {
  tab.addEventListener("click", (e) => {
    const mode = e.target.dataset.mode;
    if (!mode) return;
    
    seasonSortMode = mode;
    document.querySelectorAll(".l-tab").forEach(t => t.classList.toggle("active", t.dataset.mode === mode));
    renderLeaderboard(localStandings);
  });
});

// Modal Nav Tab Listeners
modalNavTabs.forEach(tab => {
  tab.addEventListener("click", (e) => {
    const viewName = e.target.dataset.view;
    if (!viewName) return;

    modalNavTabs.forEach(t => t.classList.remove("active"));
    e.target.classList.add("active");

    setHidden(seasonView, viewName !== "season");
    setHidden(dailyView, viewName !== "daily");
    setHidden(matchDetailView, true); // always hide details when switching top tabs

    if (viewName === "daily") {
      renderHistoryList();
    }
  });
});

backToDailyBtn?.addEventListener("click", () => {
  if (returnToPlayerName) {
    const pName = returnToPlayerName;
    returnToPlayerName = null; // Clear context after use
    try {
      if (typeof renderPlayerProfile === "function") {
        renderPlayerProfile(pName, localHistory, localStandings);
        return;
      }
    } catch (err) {
      console.error("Failed to return to player profile:", err);
    }
  }
  
  // Default fallback: return to Daily Updates list
  setHidden(matchDetailView, true);
  setHidden(dailyView, false);
});

const renderHistoryList = () => {
  const isMatchActive = Boolean(currentMeta.matchTitle);
  const isPreToss = !currentMeta.secondInnings && !currentMeta.disableScoreA && !currentMeta.disableScoreB;
  const showLiveGame = isMatchActive;

  let html = "";

  // Insert Live Game card at the top if 1st INN is unresolved
  if (showLiveGame) {
    const statusLabel = isPreToss ? "Upcoming" : "Live Now";
    const statusColor = isPreToss ? "var(--system-orange)" : "var(--system-blue)";
    
    html += `
      <div class="history-card" style="border-color: ${statusColor};" data-match="live">
        <div class="hcard-left">
          <span class="hcard-date" style="color: ${statusColor};">${statusLabel}</span>
          <span class="hcard-title">${escapeHtml(currentMeta.matchTitle)}</span>
        </div>
        <i class="fa-solid fa-chevron-right hcard-arrow"></i>
      </div>
    `;
  }

  // Parse and sort history by date descending
  const historyEntries = sortHistoryLatestFirst(localHistory)
    .filter(([key, data]) => data && data.matchTitle) // Only show full archive payloads
    .map(([key, data]) => ({ id: key, ...data }));

  if (historyEntries.length === 0 && !showLiveGame) {
    html += `<div class="empty-state">No daily updates explicitly finalized yet.</div>`;
  } else {
    html += historyEntries.map(h => `
      <div class="history-card" data-match="${h.id}">
        <div class="hcard-left">
          <span class="hcard-date">${escapeHtml(h.id.split("_")[0] || "Past Game")}</span>
          <span class="hcard-title">${escapeHtml(h.matchTitle || "Match Update")}</span>
        </div>
        <i class="fa-solid fa-chevron-right hcard-arrow"></i>
      </div>
    `).join("");
  }

  historyListContainer.innerHTML = html;

  historyListContainer.querySelectorAll(".history-card").forEach(card => {
    card.addEventListener("click", () => {
      renderMatchDetails(card.dataset.match);
    });
  });
};

const renderMatchDetails = (matchId) => {
  let standings = [];
  
  if (matchId === "live") {
    const overVal = parseFloat(currentMeta.currentOver || "0");
    const isMatchStarted = overVal > 0 || currentMeta.secondInnings;
    const isBlind = !isMatchStarted || !predictionLocked;

    if (isBlind) {
      matchDetailTitle.textContent = currentMeta.matchTitle || "Live Game";
      matchDetailTitle.dataset.matchId = "live";
      matchDetailList.innerHTML = `<tr><td colspan="5"><div class="blind-notice"><h3>Predictions are blind</h3><p>${!isMatchStarted ? "Standings will be revealed once the match starts!" : "Make your prediction first to see what others guessed!"}</p></div></td></tr>`;
      setHidden(dailyView, true);
      setHidden(matchDetailView, false);
      return;
    }

    // Show current predictions mapped to a dummy standings object
    matchDetailTitle.textContent = currentMeta.matchTitle || "Live Game";
    matchDetailTitle.dataset.matchId = "live";
    
    // Aggregation logic:
    // 1. Get all unique usernames from activePredictions, liveHist1st, and liveHist2nd
    const allUsers = new Set([
      ...Object.keys(activePredictions),
      ...Object.keys(liveHist1st),
      ...Object.keys(liveHist2nd)
    ]);

    standings = Array.from(allUsers).map(uid => {
      const pActive = activePredictions[uid] || {};
      const p1Resolved = liveHist1st[uid];
      const p2Resolved = liveHist2nd[uid];
      const name = pActive.name || p1Resolved?.name || p2Resolved?.name || "Anonymous";

      let p1Winner = "", p1Guess = "", p1Score = "-";
      let p2Winner = "", p2Guess = "", p2Score = "-";
      let total = 0;

      // Helper: pick the correct field based on which score is disabled in meta
      // Falls back to scoreA ?? scoreB when both are active
      const getActiveScore = (pred, meta) => {
        if (meta.disableScoreA) return pred.scoreB ?? "---";
        if (meta.disableScoreB) return pred.scoreA ?? "---";
        return (pred.scoreA ?? pred.scoreB) ?? "---";
      };

      // Innings 1 logic
      if (p1Resolved) {
        p1Winner = p1Resolved.predictedWinner;
        p1Guess = p1Resolved.guess ?? getActiveScore(p1Resolved, currentMeta);
        p1Score = p1Resolved.points ?? 0;
        total += Number(p1Score);
      } else if (!currentMeta.secondInnings && pActive.predictedWinner) {
        p1Winner = pActive.predictedWinner;
        p1Guess = getActiveScore(pActive, currentMeta);
        p1Score = "Live";
      } else {
        p1Winner = "";
        p1Guess = "---";
        p1Score = "-";
      }

      // Innings 2 logic
      if (p2Resolved) {
        p2Winner = p2Resolved.predictedWinner;
        p2Guess = p2Resolved.guess ?? getActiveScore(p2Resolved, currentMeta);
        p2Score = p2Resolved.points ?? 0;
        total += Number(p2Score);
      } else if (currentMeta.secondInnings && pActive.predictedWinner) {
        p2Winner = pActive.predictedWinner;
        p2Guess = getActiveScore(pActive, currentMeta);
        p2Score = "Live";
      } else {
        p2Winner = "";
        p2Guess = "---";
        p2Score = "-";
      }

      let storedPenalty = Number(pActive.penalty || 0);
      let mismatchPenalty = (p1Winner && p2Winner && p1Winner.toLowerCase() !== p2Winner.toLowerCase()) ? -20 : 0;
      let totalPenalty = storedPenalty + mismatchPenalty;

        return {
          name,
          p1Winner,
          p1Guess,
          p1Score,
          p1ScoreA: pActive.scoreA, // Added for pre-toss dual display
          p1ScoreB: pActive.scoreB, // Added for pre-toss dual display
          p2Winner,
          p2Guess,
          p2Score,
          penalty: totalPenalty,
          total: (typeof p1Score === "number" || typeof p2Score === "number") 
            ? Math.max(0, (Number(p1Score) || 0) + (Number(p2Score) || 0) - totalPenalty)
            : (p1Score === "Live" || p2Score === "Live" ? "Live" : 0)
        };
    });

    // Dedup by name: if two UIDs resolved to the same display name (e.g. manually restored 1st innings
    // key differs from the real 2nd innings Firebase UID), merge them into a single row.
    const nameMap = new Map();
    for (const row of standings) {
      const key = (row.name || "Anonymous").trim().toLowerCase();
      if (!nameMap.has(key)) {
        nameMap.set(key, { ...row });
      } else {
        const existing = nameMap.get(key);
        // Prefer the row that actually has 1st innings resolved data
        if (row.p1Score !== "-" && existing.p1Score === "-") {
          existing.p1Winner = row.p1Winner;
          existing.p1Guess  = row.p1Guess;
          existing.p1Score  = row.p1Score;
        }
        // Prefer the row that actually has 2nd innings data (resolved or live)
        if (row.p2Score !== "-" && existing.p2Score === "-") {
          existing.p2Winner = row.p2Winner;
          existing.p2Guess  = row.p2Guess;
          existing.p2Score  = row.p2Score;
        }
        // Recalculate penalty and total
        const storedPen = Math.max(Number(existing.penalty || 0), Number(row.penalty || 0));
        const mismatchPen = (existing.p1Winner && existing.p2Winner &&
          existing.p1Winner.toLowerCase() !== existing.p2Winner.toLowerCase()) ? 20 : 0;
        existing.penalty = storedPen + mismatchPen;
        
        const n1 = typeof existing.p1Score === "number" ? existing.p1Score : 0;
        const n2 = typeof existing.p2Score === "number" ? existing.p2Score : 0;
        existing.total = (existing.p1Score === "Live" || existing.p2Score === "Live")
          ? "Live"
          : Math.max(0, n1 + n2 - Number(existing.penalty || 0)); 
        nameMap.set(key, existing);
      }
    }
    standings = Array.from(nameMap.values());

    standings.sort((a, b) => {
      // 1. Live game sorting based on score predictions (Primary)
      if (!currentMeta.secondInnings) {
        const valA = isNaN(Number(a.p1Guess)) ? Infinity : Number(a.p1Guess);
        const valB = isNaN(Number(b.p1Guess)) ? Infinity : Number(b.p1Guess);
        if (valA !== valB) return valA - valB;
      } else {
        let chaser = null;
        if (currentMeta.disableScoreA && !currentMeta.disableScoreB) chaser = currentMeta.teamB;
        else if (currentMeta.disableScoreB && !currentMeta.disableScoreA) chaser = currentMeta.teamA;
        
        const aIsChaser = a.p2Winner && chaser && a.p2Winner.toLowerCase() === chaser.toLowerCase();
        const bIsChaser = b.p2Winner && chaser && b.p2Winner.toLowerCase() === chaser.toLowerCase();
        const aHasGuess = !isNaN(Number(a.p2Guess));
        const bHasGuess = !isNaN(Number(b.p2Guess));

        // Group 1: Chasing predictions, Group 2: Defending predictions, Group 3: No prediction
        const getGroup = (isChaser, hasGuess) => hasGuess ? (isChaser ? 1 : 2) : 3;
        const groupA = getGroup(aIsChaser, aHasGuess);
        const groupB = getGroup(bIsChaser, bHasGuess);

        if (groupA !== groupB) return groupA - groupB;

        if (groupA !== 3) {
          const valA = Number(a.p2Guess);
          const valB = Number(b.p2Guess);
          if (valA !== valB) return valA - valB;
        }
      }

      // 2. Tie-breaker: Total points (if available)
      const totalA = typeof a.total === "number" ? a.total : -Infinity;
      const totalB = typeof b.total === "number" ? b.total : -Infinity;
      if (totalA !== totalB) return totalB - totalA;

      // 3. Fallback: Alphabetical
      return a.name.localeCompare(b.name);
    });
    
  } else {
    // Show detailed historical standings
    const matchData = localHistory[matchId];
    if (!matchData) return;
    
    matchDetailTitle.textContent = matchData.matchTitle || "Match Details";
    matchDetailTitle.dataset.matchId = matchId;
    standings = matchData.finalStandings || [];
    
    // Sort the individual match data descending by total points (Rank)
    standings.sort((a, b) => (b.total || 0) - (a.total || 0));
  }

  if (standings.length === 0) {
    matchDetailList.innerHTML = `<tr><td colspan="5" class="empty-state">No data available for this match.</td></tr>`;
  } else {
    matchDetailList.innerHTML = standings.map(row => {
      let p1Str = "-";
      let p2Str = "-";

      if (matchId === "live") {
        const teamA = (currentMeta.teamA || "").toString().trim();
        const teamB = (currentMeta.teamB || "").toString().trim();
        const isPreToss = teamA && teamB && !currentMeta.secondInnings && !currentMeta.disableScoreA && !currentMeta.disableScoreB;
        let p1Info = "";

        if (isPreToss && row.p1ScoreA !== undefined && row.p1ScoreB !== undefined) {
          // Format: [WINNER] [SCORE_A/SCORE_B] [TEAM_A/TEAM_B]
          const winnerStr = row.p1Winner ? escapeHtml(row.p1Winner.substring(0, 3).toUpperCase()) : "";
          const teamAStr = currentMeta.teamA ? escapeHtml(currentMeta.teamA.substring(0, 3).toUpperCase()) : "A";
          const teamBStr = currentMeta.teamB ? escapeHtml(currentMeta.teamB.substring(0, 3).toUpperCase()) : "B";
          p1Info = `
            <div style="line-height: 1.2; margin: 4px 0;">
               <div style="color: var(--system-blue); font-weight: 700; font-size: 0.8rem; text-transform: uppercase; margin-bottom: 2px;">🏆 ${winnerStr} Win</div>
               <div style="font-size: 0.85rem;"><span style="opacity: 0.7;">If ${teamAStr} bats:</span> <b>${row.p1ScoreA}</b></div>
               <div style="font-size: 0.85rem;"><span style="opacity: 0.7;">If ${teamBStr} bats:</span> <b>${row.p1ScoreB}</b></div>
             </div>
           `;
        } else {
          p1Info = `${row.p1Winner ? escapeHtml(row.p1Winner.substring(0, 3).toUpperCase()) : ''} ${row.p1Guess}`;
        }

        p1Str = row.p1Score === "Live" 
           ? p1Info 
           : (row.p1Score !== "-" ? `${p1Info} <br><span class="dim">${row.p1Score} pts</span>` : "-");

        const p2Info = `${row.p2Winner ? escapeHtml(row.p2Winner.substring(0, 3).toUpperCase()) : ''} ${row.p2Guess}`;
        p2Str = row.p2Score === "Live"
           ? p2Info
           : (row.p2Score !== "-" ? `${p2Info} <br><span class="dim">${row.p2Score} pts</span>` : "-");
      } else {
        p1Str = `${row.p1Winner ? escapeHtml(row.p1Winner.substring(0, 3).toUpperCase()) : ''} ${row.p1Guess} <br><span class="dim">${row.p1Score} pts</span>`;
        p2Str = `${row.p2Winner ? escapeHtml(row.p2Winner.substring(0, 3).toUpperCase()) : ''} ${row.p2Guess} <br><span class="dim">${row.p2Score} pts</span>`;
      }
      
      const penAmt = Number(row.penalty || 0);
      const penColor = penAmt > 0 ? "color: var(--system-red);" : "";
      
      return `
        <tr>
          <td style="font-weight: 600;">
            <button class="viz-table-player-btn" data-name="${escapeHtml(row.name)}">${escapeHtml(row.name)}</button>
          </td>
          <td style="font-size: 0.9rem;">${p1Str}</td>
          <td style="font-size: 0.9rem;">${p2Str}</td>
          <td style="font-weight: 700; ${penColor}">${penAmt > 0 ? `-${penAmt}` : "-"}</td>
          <td style="text-align: right; font-weight: 800; color: var(--system-green);">${row.total}</td>
        </tr>
      `;
    }).join("");
    
    // Wire up player name clicks in the table
    matchDetailList.querySelectorAll(".viz-table-player-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const playerName = btn.dataset.name;
        const currentMatchId = matchDetailTitle.dataset.matchId;
        
        // Use the navigation return context so 'Back' from profile returns to this match
        // Note: In our current system, 'Back' from profile usually goes to daily list,
        // but we can make it smarter.
        // Actually, renderPlayerProfile just opens a modal.
        renderPlayerProfile(playerName, localHistory, localStandings);
      });
    });
  }

  setHidden(dailyView, true);
  setHidden(matchDetailView, false);
};

// Close modal when clicking outside the container
leaderboardModal?.addEventListener("click", (e) => {
  if (e.target === leaderboardModal) {
    leaderboardModal.classList.add("hidden");
    document.body.style.overflow = "";
  }
});

// Initial load
if (roomSelected) {
  // loadTrending(); // Now triggered on picker open to save bandwidth
}

// Window events for visualizer integration
window.addEventListener("viewMatchDetails", (e) => {
  const data = e.detail;
  const mid = typeof data === "string" ? data : data.matchId;
  returnToPlayerName = data.returnTo || null;

  if (!mid) return;

  // Open leaderboard modal if not open
  if (leaderboardModal) {
    leaderboardModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }
  
  // Switch to match detail view
  modalNavTabs.forEach(t => t.classList.remove("active"));
  document.querySelector('.modal-nav-tab[data-view="daily"]')?.classList.add("active");
  
  setHidden(seasonView, true);
  setHidden(dailyView, true);
  setHidden(matchDetailView, false);
  
  try {
    renderMatchDetails(mid);
  } catch (err) {
    console.error("Error rendering match details:", err);
    setHidden(dailyView, false); // Fail-safe to list view
    setHidden(matchDetailView, true);
  }
});
