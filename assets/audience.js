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
  stripKlipyUrl
} from "./shared.js";

const roomId = getRoomId();
const clientId = getClientId();
const roomSelected = hasExplicitRoomCode();

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

const KLIPY_API_KEY = "rwGYYILu8ZBT9xFPoSG2jUhq65JqUbryTlm4JXs8dWXxmR5GgGbEn5nrgvNxRCud";
const KLIPY_BASE_URL = `https://api.klipy.com/api/v1`;

let predictionLocked = false;
let predictionsPaused = false;
let allowReprediction = false;
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

  if (predictionLocked && !allowReprediction) {
    setPredictionInputsDisabled(true, meta);
    predictionSubmitButton.textContent = "Prediction locked";
    setStatus(predictionStatus, "Prediction locked", "neutral");
    return;
  }

  // If locked but allowed to repredict, fields remain disabled until user clicks Update
  if (predictionLocked && allowReprediction && !isEditingReprediction) {
    setPredictionInputsDisabled(true, meta);
    predictionSubmitButton.textContent = "Update prediction";
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
  allowReprediction = Boolean(meta.allowReprediction);

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
  const teamA = (currentMeta.teamA || "Home Team").toString().trim();
  const teamB = (currentMeta.teamB || "Away Team").toString().trim();
  const is2ndInnings = Boolean(currentMeta.secondInnings);
  
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
    const isFinished = Boolean(currentMeta.disableScoreA);
    labelScoreA.parentElement.classList.toggle("hidden", isFinished);

    labelScoreA.textContent = isOversMode ? `${teamA} Overs` : `${teamA} Score`;
    // If it's the 2nd innings, allow decimals for both fields to be safe
    scoreAInput.step = is2ndInnings ? "any" : "1";
    scoreAInput.placeholder = isOversMode ? "e.g. 18.2" : "0";
  }
  
  if (labelScoreB) {
    const isChaser = lowChaser === lowB;
    const isOversMode = is2ndInnings && isChaser && isChasingWinner;

    // Requirement: Hide score field if disabled by executive
    const isFinished = Boolean(currentMeta.disableScoreB);
    labelScoreB.parentElement.classList.toggle("hidden", isFinished);

    labelScoreB.textContent = isOversMode ? `${teamB} Overs` : `${teamB} Score`;
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
        viewerNameInput.value = prediction.name || viewerNameInput.value;
        scoreAInput.value = (prediction.scoreA !== undefined && prediction.scoreA !== null) ? prediction.scoreA : "";
        scoreBInput.value = (prediction.scoreB !== undefined && prediction.scoreB !== null) ? prediction.scoreB : "";
        predictedWinnerInput.value = prediction.predictedWinner || "";
      }

      // We don't have meta yet here usually, but syncPredictionAccess will be called by meta listener
    });

    onValue(roomRef(roomId, "predictions"), (snapshot) => {
      const predictions = Object.values(snapshot.val() || {});
      const tally = formatWinnerCounts(predictions);
      const summary = Object.entries(tally)
        .map(([winner, count]) => `${winner}: ${count}`)
        .join(" | ");

      if (!predictionsPaused && (!predictionLocked || allowReprediction)) {
        setStatus(predictionStatus, summary || "Live");
      }
    });
  }
}

predictionForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  // Handle 'Update' click to toggle edit mode
  if (predictionLocked && allowReprediction && !isEditingReprediction && !predictionsPaused) {
    isEditingReprediction = true;
    syncPredictionAccess(currentMeta);
    return;
  }

  if (!isFirebaseConfigured || !db || (predictionLocked && !allowReprediction) || predictionsPaused) {
    syncPredictionAccess();
    return;
  }

  const name = viewerNameInput.value.trim();
  let scoreA = scoreAInput.value !== "" ? Number(scoreAInput.value) : null;
  let scoreB = scoreBInput.value !== "" ? Number(scoreBInput.value) : null;
  const predictedWinner = predictedWinnerInput.value.trim();
  const lowWinner = predictedWinner.toLowerCase();
  const lowChaser = (chasingTeam || "").toLowerCase();

  // Validate Overs format for Chaser
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

      // Ensure .0 is preserved if needed (stored as number, so we handle display later)
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

  rememberViewerName(name);
  setStatus(predictionStatus, "Sending...");

  try {
    await savePrediction(roomId, clientId, {
      clientId,
      name,
      scoreA,
      scoreB,
      predictedWinner
    });
    predictionLocked = true;
    isEditingReprediction = false;
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
  if (!response.ok) throw new Error(`Klipy API error: ${response.status}`);
  return await response.json();
};

const renderGifs = (gifs) => {
  if (!gifs || gifs.length === 0) {
    gifGrid.innerHTML = `<div class="empty-state">No GIFs found.</div>`;
    return;
  }

  gifGrid.innerHTML = gifs.map(gif => {
    // Klipy API nesting for individual GIF files: gif.file.sm.gif.url or gif.file.hd.gif.url
    const gifUrl = gif.file?.sm?.gif?.url || gif.file?.hd?.gif?.url || gif.files?.gif?.url;
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

        // Close picker after sending
        setHidden(gifPickerContainer, true);
        toggleGifPickerBtn.classList.remove("active");
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
    const data = await fetchKlipy(`${currentMediaType}/trending`, { limit: 12 });
    // Klipy API nesting: data.data.data
    const gifs = data?.data?.data || [];
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
    const data = await fetchKlipy(`${currentMediaType}/search`, { q: query, limit: 12 });
    // Klipy API nesting: data.data.data
    const gifs = data?.data?.data || [];
    renderGifs(gifs);
    setReactionStatus("Ready");
  } catch (err) {
    console.error(err);
    setReactionStatus("Search failed", "danger");
  }
};

gifSearchInput?.addEventListener("input", (e) => {
  // Simple debounce logic could be added here, but let's stick to keypress for now to avoid rapid API calls
});

gifSearchInput?.addEventListener("keypress", (e) => {
  if (e.key === "Enter") handleGifSearch();
});

// Initial load
if (roomSelected) {
  // loadTrending(); // Now triggered on picker open to save bandwidth
}
