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

// Leaderboard UI
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

let localHistory = {};
let activePredictions = {};

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

    // --- Season Leaderboard Listener ---
    onValue(roomRef(roomId, "season_leaderboard"), (snapshot) => {
      const data = snapshot.val() || {};
      const standings = data.standings || [];
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
        viewerNameInput.value = prediction.name || viewerNameInput.value;
        scoreAInput.value = (prediction.scoreA !== undefined && prediction.scoreA !== null) ? prediction.scoreA : "";
        scoreBInput.value = (prediction.scoreB !== undefined && prediction.scoreB !== null) ? prediction.scoreB : "";
        predictedWinnerInput.value = prediction.predictedWinner || "";
      }

      // We don't have meta yet here usually, but syncPredictionAccess will be called by meta listener
    });

    // --- History Listener ---
    onValue(roomRef(roomId, "history"), (snapshot) => {
      localHistory = snapshot.val() || {};
      if (!dailyView.classList.contains("hidden")) {
        renderHistoryList();
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

      if (!predictionsPaused && (!predictionLocked || allowReprediction)) {
        setStatus(predictionStatus, summary || "Live");
      }

      // If we are currently looking at the live match details in the modal, re-render it
      if (!matchDetailView.classList.contains("hidden") && matchDetailTitle.dataset.matchId === "live") {
        renderMatchDetails("live");
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
let seasonSortMode = "total"; // "total" or "ppg"
let localStandings = [];

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

    return `
      <tr class="${rowClass}">
        <td style="width: 60px;">
          <div class="${badgeClass}">${rank}</div>
        </td>
        <td class="player-info">
          <span class="player-name">${escapeHtml(player.name)}</span>
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

closeLeaderboardBtn?.addEventListener("click", () => {
  leaderboardModal.classList.add("hidden");
  document.body.style.overflow = "";
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
  setHidden(matchDetailView, true);
  setHidden(dailyView, false);
});

const renderHistoryList = () => {
  const isFirstInningsUnresolved = !currentMeta.secondInnings && Object.keys(activePredictions).length > 0;
  const showLiveGame = isFirstInningsUnresolved && currentMeta.matchTitle;

  let html = "";

  // Insert Live Game card at the top if 1st INN is unresolved
  if (showLiveGame) {
    html += `
      <div class="history-card" style="border-color: var(--system-blue);" data-match="live">
        <div class="hcard-left">
          <span class="hcard-date" style="color: var(--system-blue);">Live Now</span>
          <span class="hcard-title">${escapeHtml(currentMeta.matchTitle)}</span>
        </div>
        <i class="fa-solid fa-chevron-right hcard-arrow"></i>
      </div>
    `;
  }

  // Parse and sort history by date descending
  const historyEntries = sortHistoryLatestFirst(localHistory).map(([key, data]) => ({ id: key, ...data }));

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
    // Show current predictions mapped to a dummy standings object
    matchDetailTitle.textContent = currentMeta.matchTitle || "Live Game";
    matchDetailTitle.dataset.matchId = "live";
    
    standings = Object.values(activePredictions).map(p => ({
      name: p.name || "Anonymous",
      p1Winner: p.predictedWinner,
      p1Guess: (p.scoreA ?? p.scoreB) || "---",
      p1Score: "Live",
      p2Score: "-",
      penalty: "-",
      total: "-"
    }));
    
    // Sort live alphabetically normally, but we can stick to points for rank naturally 
    standings.sort((a, b) => a.name.localeCompare(b.name));
    
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
      const p1Str = matchId === "live" 
         ? `${row.p1Winner ? escapeHtml(row.p1Winner.substring(0, 3).toUpperCase()) : ''} ${row.p1Guess}`
         : `${row.p1Winner ? escapeHtml(row.p1Winner.substring(0, 3).toUpperCase()) : ''} ${row.p1Guess} <br><span class="dim">${row.p1Score} pts</span>`;
         
      const p2Str = matchId === "live" ? "-" : `${row.p2Winner ? escapeHtml(row.p2Winner.substring(0, 3).toUpperCase()) : ''} ${row.p2Guess} <br><span class="dim">${row.p2Score} pts</span>`;
      
      const penAmt = Number(row.penalty || 0);
      const penColor = penAmt < 0 ? "color: var(--system-red);" : "";
      
      return `
        <tr>
          <td style="font-weight: 600;">${escapeHtml(row.name)}</td>
          <td style="font-size: 0.9rem;">${matchId === "live" ? p1Str : (row.p1Score > 0 ? p1Str : "-")}</td>
          <td style="font-size: 0.9rem;">${matchId === "live" ? p2Str : (row.p2Score > 0 ? p2Str : "-")}</td>
          <td style="font-weight: 700; ${penColor}">${penAmt < 0 ? penAmt : "-"}</td>
          <td style="text-align: right; font-weight: 800; color: var(--system-green);">${row.total}</td>
        </tr>
      `;
    }).join("");
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
