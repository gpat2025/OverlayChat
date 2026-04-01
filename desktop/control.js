import {
  db,
  isFirebaseConfigured,
  onValue,
  query,
  limitToLast,
  ref,
  roomRef,
  saveRoomMeta,
  clearRoomNode,
  getOnce,
  updateActiveSession,
  saveInningsHistory,
  getInningsHistory,
  archiveToHistory,
  getHistory,
  wipeMatchData
} from "../assets/firebase.js";
import { getAudienceEntryUrl, escapeHtml } from "../assets/shared.js";

const settingsForm = document.querySelector("#settingsForm");
const roomIdInput = document.querySelector("#roomId");
const matchTitleInput = document.querySelector("#matchTitle");
const teamAInput = document.querySelector("#teamA");
const teamBInput = document.querySelector("#teamB");
const allowRepredictionInput = document.querySelector("#allowReprediction");
const labelBattingA = document.querySelector("#labelBattingA");
const labelBattingB = document.querySelector("#labelBattingB");
const hideJoinInput = document.querySelector("#hideJoin");
const audienceUrlInput = document.querySelector("#audienceUrl");
const copyAudienceUrlButton = document.querySelector("#copyAudienceUrl");
const opacityInput = document.querySelector("#opacity");
const opacityValue = document.querySelector("#opacityValue");
const overlayStatus = document.querySelector("#overlayStatus");
const clickThroughStatus = document.querySelector("#clickThroughStatus");
const predictionPauseStatus = document.querySelector("#predictionPauseStatus");
const togglePredictionPauseButton = document.querySelector("#togglePredictionPause");
const showOverlayButton = document.querySelector("#showOverlay");
const hideOverlayButton = document.querySelector("#hideOverlay");
const reloadOverlayButton = document.querySelector("#reloadOverlay");
const resetBoundsButton = document.querySelector("#resetBounds");
const toggleHideChatButton = document.querySelector("#toggleHideChat");
const toggleHideJoinButton = document.querySelector("#toggleHideJoin");
const clearPredictionsButton = document.querySelector("#clearPredictions");
const clearChatButton = document.querySelector("#clearChat");
const showTickerButton = document.querySelector("#showTicker");
const hideTickerButton = document.querySelector("#hideTicker");
const reloadTickerButton = document.querySelector("#reloadTicker");
const resetTickerBoundsButton = document.querySelector("#resetTickerBounds");
const sortStatus = document.querySelector("#sortStatus");
const toggleSortModeButton = document.querySelector("#toggleSortMode");
const dotSort = document.querySelector("#dotSort");
const clearReactionsButton = document.querySelector("#clearReactions");
const showReactionButton = document.querySelector("#showReaction");
const hideReactionButton = document.querySelector("#hideReaction");
const reloadReactionButton = document.querySelector("#reloadReaction");
const resetReactionBoundsButton = document.querySelector("#resetReactionBounds");

// Win Probability Elements
const googleMatchUrlInput = document.querySelector("#googleMatchUrl");
const autoFetchWinProbToggle = document.querySelector("#autoFetchWinProb");
const showWinProbToggle = document.querySelector("#showWinProb");
const winProbValueLabel = null;
const winProbError = null;
const fetchNowBtn = document.querySelector("#fetchNowBtn");
const fetchStatus = document.querySelector("#fetchStatus");
const viewDebugBtn = document.querySelector("#viewDebugBtn");
const solveCaptchaBtn = document.querySelector("#solveCaptchaBtn");

let lastResults = [];
let lastOverallResults = [];
let fullHistory = {};

// UI Elements for History & Leaderboard
const mainViewHistoryBtn = document.querySelector("#mainViewHistoryBtn");
const historyDashboard = document.querySelector("#historyDashboard");
const closeHistoryBtn = document.querySelector("#closeHistory");
const matchList = document.querySelector("#matchList");
const matchDetail = document.querySelector("#matchDetail");

// Manual Entry Elements
const manualEntryDashboard = document.querySelector("#manualEntryDashboard");
const showManualEntryBtn = document.querySelector("#showManualEntry");
const closeManualEntryBtn = document.querySelector("#closeManualEntry");
const addManualRowBtn = document.querySelector("#addManualRow");
const manualPlayersBody = document.querySelector("#manualPlayersBody");
const saveManualMatchBtn = document.querySelector("#saveManualMatch");
const cancelManualSaveBtn = document.querySelector("#cancelManualSave");
const manTeamAInput = document.querySelector("#manualTeamA");
const manTeamBInput = document.querySelector("#manualTeamB");

// Edit Match Elements
const editMatchModal = document.querySelector("#editMatchModal");
const editMatchTitle = document.querySelector("#editMatchTitle");
const editMatchDate = document.querySelector("#editMatchDate");
const editActual1st = document.querySelector("#editActual1st");
const editActual2nd = document.querySelector("#editActual2nd");
const editTeamA = document.querySelector("#editTeamA");
const editTeamB = document.querySelector("#editTeamB");
const editWinRadioA = document.querySelector("#editWinRadioA");
const editWinRadioB = document.querySelector("#editWinRadioB");
const editLabelA = document.querySelector("#editLabelA");
const editLabelB = document.querySelector("#editLabelB");
const cancelEditMatchBtn = document.querySelector("#cancelEditMatch");
const saveEditMatchBtn = document.querySelector("#saveEditMatch");

// Status Dots
const dotOverlay = document.querySelector("#dotOverlay");
const dotInteractivity = document.querySelector("#dotInteractivity");
const dotPredictions = document.querySelector("#dotPredictions");

let currentSettings = null;
let currentMeta = {};
let stopMetaSubscription = null;
let heartbeatInterval = null;

const normalizeRoomId = (value) =>
  value.toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 40) || "ipl-main";

const setStatusText = (settings) => {
  currentSettings = settings;

  // Update Text
  overlayStatus.textContent = settings.overlayVisible ? "Visible" : "Hidden";
  clickThroughStatus.textContent = settings.clickThrough ? "Click-through" : "Interactive";
  opacityValue.textContent = `${Math.round(settings.opacity * 100)}%`;

  // Update Dots
  if (dotOverlay) {
    dotOverlay.className = `dot ${settings.overlayVisible ? 'active' : 'inactive'}`;
  }
  if (dotInteractivity) {
    dotInteractivity.className = `dot ${settings.clickThrough ? 'warning' : 'active'}`;
  }

  const reactionStatus = document.querySelector("#reactionStatus");
  if (reactionStatus) {
    reactionStatus.textContent = settings.reactionVisible ? "Visible" : "Hidden";
    reactionStatus.className = `inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${settings.reactionVisible ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'}`;
  }

  roomIdInput.value = settings.roomId;
  opacityInput.value = settings.opacity;
  audienceUrlInput.value = getAudienceEntryUrl();
};

const syncPauseUi = () => {
  const paused = Boolean(currentMeta.predictionsPaused);
  predictionPauseStatus.textContent = paused ? "Paused" : "Live";
  togglePredictionPauseButton.textContent = paused
    ? "Resume Predictions"
    : "Pause Predictions";

  if (dotPredictions) {
    dotPredictions.className = `dot ${paused ? 'inactive' : 'active'}`;
  }
};

const syncChatUi = () => {
  const hidden = Boolean(currentMeta.hideChat);
  toggleHideChatButton.textContent = hidden
    ? "Show Live Chat"
    : "Hide Live Chat";
};

const syncJoinUi = () => {
  const hidden = Boolean(currentMeta.hideJoin);
  toggleHideJoinButton.textContent = hidden
    ? "Show Join Section"
    : "Hide Join Section";
};

const syncSortUi = () => {
  const sortMode = currentMeta.predictionSort || "newest";
  const isScore = sortMode === "score";

  sortStatus.textContent = isScore ? "Score (Asc)" : "Newest First";
  toggleSortModeButton.textContent = isScore
    ? "Sort by Newest"
    : "Sort by Score";

  if (dotSort) {
    dotSort.className = `dot ${isScore ? 'active' : 'warning'}`;
  }
};

const getFormMeta = () => {
  const battingTeam = document.querySelector('input[name="battingTeam"]:checked')?.value;
  const innings = document.querySelector('input[name="innings"]:checked')?.value;

  return {
    matchTitle: matchTitleInput.value.trim(),
    teamA: teamAInput.value.trim(),
    teamB: teamBInput.value.trim(),
    allowReprediction: allowRepredictionInput.checked,
    disableScoreA: battingTeam === "away", // Home is batting -> Away is disabled
    disableScoreB: battingTeam === "home", // Away is batting -> Home is disabled
    secondInnings: innings === "2",
    predictionSort: currentMeta.predictionSort || "newest",
    predictionsPaused: Boolean(currentMeta.predictionsPaused),
    hideChat: Boolean(currentMeta.hideChat),
    hideJoin: Boolean(currentMeta.hideJoin)
  };
};

const subscribeToMeta = (roomId) => {
  if (stopMetaSubscription) {
    stopMetaSubscription();
    stopMetaSubscription = null;
  }

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  if (!isFirebaseConfigured || !db) {
    currentMeta = {};
    syncPauseUi();
    syncChatUi();
    return;
  }

  // Start discovery heartbeat
  const tick = () => updateActiveSession(roomId).catch(console.error);
  tick();
  heartbeatInterval = setInterval(tick, 20000);

  stopMetaSubscription = onValue(roomRef(roomId, "meta"), (snapshot) => {
    currentMeta = snapshot.val() || {};

    const teamA = currentMeta.teamA || "";
    const teamB = currentMeta.teamB || "";

    matchTitleInput.value = currentMeta.matchTitle || "";
    teamAInput.value = teamA;
    teamBInput.value = teamB;

    // Update Toggle Labels
    if (labelBattingA) labelBattingA.textContent = teamA || "Home Team";
    if (labelBattingB) labelBattingB.textContent = teamB || "Away Team";

    allowRepredictionInput.checked = Boolean(currentMeta.allowReprediction);

    // Sync Batting Team Radio
    if (!currentMeta.disableScoreA && currentMeta.disableScoreB) {
      document.getElementById("battingA").checked = true;
    } else if (!currentMeta.disableScoreB && currentMeta.disableScoreA) {
      document.getElementById("battingB").checked = true;
    }

    // Sync Innings Radio
    if (currentMeta.secondInnings) {
      document.getElementById("innings2nd").checked = true;
    } else {
      document.getElementById("innings1st").checked = true;
    }

    syncPauseUi();
    syncChatUi();
    syncJoinUi();
    syncSortUi();
    syncWinProbUi();
    updateResolutionVisibility();
  });
};

const syncWinProbUi = () => {
  if (!currentMeta) return;

  const show = Boolean(currentMeta.showWinProb);
  showWinProbToggle.checked = show;

  const probA = currentMeta.winProbabilityA !== undefined ? currentMeta.winProbabilityA : 50;
  if (winProbError) winProbError.classList.add("hidden");
  updateWinProbSliderLabel(probA);

  if (currentMeta.googleMatchUrl) {
    googleMatchUrlInput.value = currentMeta.googleMatchUrl;
  }
};

const updateWinProbSliderLabel = (val) => {
  if (!winProbValueLabel) return;
  const probA = Number(val);
  const probB = 100 - probA;
  winProbValueLabel.textContent = `${probA}% / ${probB}%`;
};

// Automation Logic
let winProbInterval = null;

const startWinProbAutomation = () => {
  if (winProbInterval) clearInterval(winProbInterval);

  winProbInterval = setInterval(async () => {
    if (!autoFetchWinProbToggle.checked || !googleMatchUrlInput.value.trim()) return;
    performWinProbFetch();
  }, 30000); // 30 seconds
};

const performWinProbFetch = async () => {
  const url = googleMatchUrlInput.value.trim();
  if (!url) {
    if (fetchStatus) fetchStatus.textContent = "Status: No URL provided";
    return;
  }

  if (fetchStatus) fetchStatus.textContent = "Status: Fetching...";
  if (fetchNowBtn) fetchNowBtn.disabled = true;

  try {
    const result = await window.overlayDesktop.fetchWinProbability(url);

    if (result && result.probA && result.probB) {
      const valA = parseInt(result.probA);

      // Update UI
      if (winProbError) winProbError.classList.add("hidden");
      if (fetchStatus) fetchStatus.textContent = `Status: Success (${result.probA} / ${result.probB})`;

      if (isFirebaseConfigured && db) {
        const roomId = normalizeRoomId(roomIdInput.value.trim());
        await saveRoomMeta(roomId, {
          winProbabilityA: valA,
          winProbabilityB: 100 - valA
        });
      }
    } else {
      if (fetchStatus) fetchStatus.textContent = "Status: Failed (Widget not found)";
      if (winProbError) winProbError.classList.remove("hidden");
    }
  } catch (error) {
    console.error(error);
    if (fetchStatus) fetchStatus.textContent = "Status: Error (Check console)";
    if (winProbError) winProbError.classList.remove("hidden");
  } finally {
    if (fetchNowBtn) fetchNowBtn.disabled = false;
  }
};

startWinProbAutomation();

// Add listeners to update labels in real-time
teamAInput.addEventListener("input", () => {
  if (labelBattingA) labelBattingA.textContent = teamAInput.value.trim() || "Home Team";
});
teamBInput.addEventListener("input", () => {
  if (labelBattingB) labelBattingB.textContent = teamBInput.value.trim() || "Away Team";
});

// Slider event listeners removed as requested.

showWinProbToggle.addEventListener("change", async () => {
  if (isFirebaseConfigured && db) {
    const roomId = normalizeRoomId(roomIdInput.value.trim());
    await saveRoomMeta(roomId, {
      showWinProb: showWinProbToggle.checked
    });
  }
});

googleMatchUrlInput.addEventListener("change", async () => {
  if (isFirebaseConfigured && db) {
    const roomId = normalizeRoomId(roomIdInput.value.trim());
    await saveRoomMeta(roomId, {
      googleMatchUrl: googleMatchUrlInput.value.trim()
    });
  }
});

fetchNowBtn.addEventListener("click", (e) => {
  e.preventDefault();
  performWinProbFetch();
});

if (viewDebugBtn) {
  viewDebugBtn.addEventListener("click", (e) => {
    e.preventDefault();
    window.overlayDesktop.viewScraperDebug();
  });
}

if (solveCaptchaBtn) {
  solveCaptchaBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const url = googleMatchUrlInput.value.trim();
    if (url) {
      window.overlayDesktop.openScraperSolver(url);
    } else {
      alert("Please paste the Google Match URL first.");
    }
  });
}

// Update Resolution UI immediately when toggles change
document.querySelectorAll('input[name="innings"]').forEach(radio => {
  radio.addEventListener('change', () => {
    currentMeta.secondInnings = (radio.value === "2");
    updateResolutionVisibility();
  });
});

document.querySelectorAll('input[name="battingTeam"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const val = radio.value;
    currentMeta.disableScoreA = (val === "away");
    currentMeta.disableScoreB = (val === "home");
    updateResolutionVisibility();
  });
});

const loadInitialState = async () => {
  const settings = await window.overlayDesktop.getSettings();
  setStatusText(settings);
  subscribeToMeta(settings.roomId);
  updateSeasonLeaderboard();
};

const copyAudienceUrl = async () => {
  try {
    await window.overlayDesktop.copyText(audienceUrlInput.value);
    copyAudienceUrlButton.textContent = "Copied";
    window.setTimeout(() => {
      copyAudienceUrlButton.textContent = "Copy";
    }, 1400);
  } catch (error) {
    console.error(error);
    copyAudienceUrlButton.textContent = "Failed";
    window.setTimeout(() => {
      copyAudienceUrlButton.textContent = "Copy";
    }, 1400);
  }
};

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitBtn = settingsForm.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;

  const roomId = normalizeRoomId(roomIdInput.value.trim());

  // Visual Feedback
  submitBtn.disabled = true;
  submitBtn.textContent = "Deploying...";

  try {
    const nextSettings = await window.overlayDesktop.updateSettings({
      roomId,
      opacity: Number(opacityInput.value)
    });
    setStatusText(nextSettings);
    subscribeToMeta(roomId);

    if (isFirebaseConfigured && db) {
      await saveRoomMeta(roomId, getFormMeta());
    }

    await window.overlayDesktop.reloadOverlay();

    submitBtn.textContent = "Deployed";
    setTimeout(() => {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }, 1500);
  } catch (error) {
    console.error(error);
    submitBtn.textContent = "Error";
    setTimeout(() => {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }, 2000);
  }
});

opacityInput.addEventListener("input", async () => {
  const opacity = Number(opacityInput.value);
  opacityValue.textContent = `${Math.round(opacity * 100)}%`;
  setStatusText(await window.overlayDesktop.updateSettings({ opacity }));
});

copyAudienceUrlButton.addEventListener("click", copyAudienceUrl);

togglePredictionPauseButton.addEventListener("click", async () => {
  if (!isFirebaseConfigured || !db || !currentSettings) {
    return;
  }

  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);
  const nextPaused = !Boolean(currentMeta.predictionsPaused);

  try {
    const meta = getFormMeta();
    meta.predictionsPaused = nextPaused;

    await saveRoomMeta(roomId, meta);
    currentMeta = {
      ...currentMeta,
      predictionsPaused: nextPaused
    };
    syncPauseUi();
    await window.overlayDesktop.reloadOverlay();
  } catch (error) {
    console.error(error);
  }
});

toggleHideChatButton.addEventListener("click", async () => {
  if (!isFirebaseConfigured || !db || !currentSettings) {
    return;
  }

  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);
  const nextHideChat = !Boolean(currentMeta.hideChat);

  try {
    const meta = getFormMeta();
    meta.hideChat = nextHideChat;

    await saveRoomMeta(roomId, meta);
    currentMeta = {
      ...currentMeta,
      hideChat: nextHideChat
    };
    syncChatUi();
  } catch (error) {
    console.error(error);
  }
});

toggleHideJoinButton.addEventListener("click", async () => {
  if (!isFirebaseConfigured || !db || !currentSettings) {
    return;
  }

  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);
  const nextHideJoin = !Boolean(currentMeta.hideJoin);

  try {
    const meta = getFormMeta();
    meta.hideJoin = nextHideJoin;

    await saveRoomMeta(roomId, meta);
    currentMeta = {
      ...currentMeta,
      hideJoin: nextHideJoin
    };
    syncJoinUi();
  } catch (error) {
    console.error(error);
  }
});

toggleSortModeButton.addEventListener("click", async () => {
  if (!isFirebaseConfigured || !db || !currentSettings) {
    return;
  }

  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);
  const currentSort = currentMeta.predictionSort || "newest";
  const nextSort = currentSort === "newest" ? "score" : "newest";

  try {
    const meta = getFormMeta();
    meta.predictionSort = nextSort;

    await saveRoomMeta(roomId, meta);
    currentMeta = {
      ...currentMeta,
      predictionSort: nextSort
    };
    syncSortUi();
    await window.overlayDesktop.reloadOverlay();
  } catch (error) {
    console.error(error);
  }
});

showOverlayButton.addEventListener("click", async () => {
  setStatusText(await window.overlayDesktop.showOverlay());
});

hideOverlayButton.addEventListener("click", async () => {
  setStatusText(await window.overlayDesktop.hideOverlay());
});

reloadOverlayButton.addEventListener("click", async () => {
  setStatusText(await window.overlayDesktop.reloadOverlay());
});

resetBoundsButton.addEventListener("click", async () => {
  setStatusText(await window.overlayDesktop.resetBounds());
});

showTickerButton.addEventListener("click", async () => {
  setStatusText(await window.overlayDesktop.showTicker());
});

hideTickerButton.addEventListener("click", async () => {
  setStatusText(await window.overlayDesktop.hideTicker());
});

reloadTickerButton.addEventListener("click", async () => {
  setStatusText(await window.overlayDesktop.reloadTicker());
});

resetTickerBoundsButton.addEventListener("click", async () => {
  setStatusText(await window.overlayDesktop.resetTickerBounds());
});

window.overlayDesktop.onSettingsChanged((settings) => {
  setStatusText(settings);
  subscribeToMeta(settings.roomId);
  updateSeasonLeaderboard();
});

const handleClear = async (node, button) => {
  if (!isFirebaseConfigured || !db || !currentSettings) return;
  const originalText = button.textContent;
  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);

  if (!confirm(`Are you sure you want to clear ALL ${node} for room ${roomId}?`)) return;

  try {
    button.disabled = true;
    button.textContent = "Clearing...";
    await clearRoomNode(roomId, node);
    button.textContent = "Cleared";
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 1500);
  } catch (error) {
    console.error(error);
    button.textContent = "Error";
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 1500);
  }
};

clearPredictionsButton.addEventListener("click", () => handleClear("predictions", clearPredictionsButton));
clearChatButton.addEventListener("click", () => handleChatClear());
clearReactionsButton.addEventListener("click", () => handleClear("reaction", clearReactionsButton));

const handleChatClear = async () => {
  handleClear("chat", clearChatButton);
};

showReactionButton.addEventListener("click", () => window.overlayDesktop.showReaction());
hideReactionButton.addEventListener("click", () => window.overlayDesktop.hideReaction());
reloadReactionButton.addEventListener("click", () => window.overlayDesktop.reloadReaction());
resetReactionBoundsButton.addEventListener("click", () => window.overlayDesktop.resetReactionBounds());


// Match Resolution Logic
const resolution1st = document.getElementById("resolution1st");
const resolution2nd = document.getElementById("resolution2nd");
const actualScoreInput = document.getElementById("actualScore");
const chaserWonRadios = document.getElementsByName("chaserWon");
const labelChaserWon = document.getElementById("labelChaserWon");
const actualResultInput = document.getElementById("actualResult");
const labelActualResult = document.getElementById("labelActualResult");
const calculatePointsButton = document.getElementById("calculatePoints");
const resultsDashboard = document.getElementById("resultsDashboard");
const resultsBody = document.getElementById("resultsBody");
const closeResultsButton = document.getElementById("closeResults");
const resActualScoreLabel = document.getElementById("resActualScore");
const resSectionTitle = document.getElementById("resSectionTitle");
const viewFinalStandingsButton = document.getElementById("viewFinalStandings");
const overallDashboard = document.getElementById("overallDashboard");
const overallBody = document.getElementById("overallBody");
const overallMatchTitle = document.getElementById("overallMatchTitle");
const closeOverallButton = document.getElementById("closeOverall");
const exportOverallCsvButton = document.getElementById("exportOverallCsv");
const endMatchButton = document.getElementById("endMatch");
const exportCsvButton = document.getElementById("exportCsv");
const clearPrep2ndButton = document.getElementById("clearAndPrep2nd");


// Helper for Cricket Overs
const oversToBalls = (val) => {
  const parts = val.toString().split(".");
  const overs = parseInt(parts[0]) || 0;
  const balls = parts.length > 1 ? parseInt(parts[1]) : 0;
  return (overs * 6) + balls;
};

// Helper for Over Number (e.g. 17.2 is in the 18th over)
const getOverNum = (val) => {
  const parts = val.toString().split(".");
  const overs = parseInt(parts[0]) || 0;
  const balls = parts.length > 1 ? parseInt(parts[1]) : 0;
  return balls > 0 ? overs + 1 : overs;
};

// Helper to format balls to Overs (e.g. 19 -> 3.1 ov)
const ballsToOversDisplay = (balls) => {
  const overs = Math.floor(balls / 6);
  const rem = balls % 6;
  return `${overs}.${rem} ov`;
};

const updateResolutionVisibility = () => {
  const is2nd = Boolean(currentMeta.secondInnings);
  resolution1st.classList.toggle("hidden", is2nd);
  resolution2nd.classList.toggle("hidden", !is2nd);

  if (resSectionTitle) {
    resSectionTitle.textContent = "Match Resolution";
  }

  if (calculatePointsButton) {
    calculatePointsButton.textContent = is2nd ? "Resolve 2nd Innings" : "Resolve 1st Innings";
  }

  // Strictly disable/enable inputs based on section
  actualScoreInput.disabled = is2nd;
  actualResultInput.disabled = !is2nd;
  chaserWonRadios.forEach(r => r.disabled = !is2nd);

  if (is2nd) {
    const teamA = (currentMeta.teamA || "Team A").toString().trim();
    const teamB = (currentMeta.teamB || "Team B").toString().trim();

    // Identify Chasing Team
    let chasingTeam = teamB; // Default
    if (currentMeta.disableScoreA && !currentMeta.disableScoreB) {
      chasingTeam = teamB;
    } else if (currentMeta.disableScoreB && !currentMeta.disableScoreA) {
      chasingTeam = teamA;
    }

    labelChaserWon.textContent = `Did ${chasingTeam} win?`;

    // Sync result label based on current radio selection
    updateResultLabel();

    // Reset CLEAR button text for 2nd innings
    clearPrep2ndButton.textContent = "Final Resolve & Clear Room";
  } else {
    clearPrep2ndButton.textContent = "Clear All & Prep 2nd Innings";
  }
};

const updateResultLabel = () => {
  const chaserWon = document.querySelector('input[name="chaserWon"]:checked')?.value === "yes";

  if (chaserWon) {
    labelActualResult.textContent = "Actual Overs (e.g. 15.2)";
    actualResultInput.placeholder = "e.g. 15.2";
  } else {
    labelActualResult.textContent = "Actual Chasing Score";
    actualResultInput.placeholder = "e.g. 145";
  }
};

chaserWonRadios.forEach(radio => {
  radio.addEventListener("change", updateResultLabel);
});

const calculateInnings1Points = (prediction, actual, metaOverride = null) => {
  const meta = metaOverride || currentMeta;
  const teamA = (meta.teamA || "Team A").toLowerCase();
  const teamB = (meta.teamB || "Team B").toLowerCase();

  // Decide which score to use based on which one is active
  let predScore = 0;
  if (!meta.disableScoreA && meta.disableScoreB) predScore = Number(prediction.scoreA) || 0;
  else if (!meta.disableScoreB && meta.disableScoreA) predScore = Number(prediction.scoreB) || 0;
  else {
    // Both active: use predicted winner's score or max
    const winner = (prediction.predictedWinner || "").toLowerCase();
    if (winner === teamA) predScore = Number(prediction.scoreA) || 0;
    else if (winner === teamB) predScore = Number(prediction.scoreB) || 0;
    else predScore = Math.max(Number(prediction.scoreA) || 0, Number(prediction.scoreB) || 0);
  }

  const diff = Math.abs(actual - predScore);
  if (diff === 0) return { points: 200, diff, rawDiff: 0, isExact: true, isNear5: true, isNear10: true, guess: predScore, mode: "Score" };

  const base = Math.round(Math.max(0, 120 - (diff * 1.2)));
  const near5 = diff <= 5 ? 20 : 0;
  const near10 = diff <= 10 ? 10 : 0;

  return {
    points: base + near5 + near10,
    diff,
    rawDiff: diff,
    isExact: false,
    isNear5: diff <= 5,
    isNear10: diff <= 10,
    guess: predScore,
    mode: "Score"
  };
};

const calculateInnings2Points = (prediction, actualWinner, actualResult, metaOverride = null, isOversOverride = null) => {
  const meta = metaOverride || currentMeta;
  const predWinner = (prediction.predictedWinner || "").toLowerCase();
  
  const teamA = (meta.teamA || "Team A").toLowerCase();
  const teamB = (meta.teamB || "Team B").toLowerCase();
  let chasingTeam = teamB; // Default

  if (meta.disableScoreA && !meta.disableScoreB) {
    chasingTeam = teamB;
  } else if (meta.disableScoreB && !meta.disableScoreA) {
    chasingTeam = teamA;
  }

  // Use override if provided, otherwise fallback to DOM label
  let isChaserWinner = isOversOverride !== null 
    ? isOversOverride 
    : (labelActualResult && labelActualResult.textContent.includes("Overs"));

  const predVal = chasingTeam === teamA ? prediction.scoreA : prediction.scoreB;

  if (predWinner !== actualWinner) {
    // If they got winner wrong, points = 0
    let wrongDiff = 0;
    if (isChaserWinner) {
      const actualBalls = oversToBalls(actualResult);
      const predBalls = oversToBalls(predVal || 0);
      wrongDiff = Math.abs(actualBalls - predBalls);
    } else {
      wrongDiff = Math.abs(Number(actualResult) - Number(predVal || 0));
    }
    return { points: 0, diff: "---", rawDiff: wrongDiff, guess: (predVal !== null && predVal !== undefined) ? predVal : "---", isExact: false, mode: "Wrong Winner" };
  }

  let points = 0; // Removed 40 base for winner
  
  if (isChaserWinner) {
    const actualBalls = oversToBalls(actualResult);
    const predBalls = oversToBalls(predVal || 0);
    const diff = Math.abs(actualBalls - predBalls);
    
    // Max accuracy points: 120
    const accuracy = Math.round(Math.max(0, 120 - (diff * 1.8)));
    const near3Bonus = (diff <= 3) ? 20 : 0;
    const rangeBonus = (diff <= 9) ? 10 : 0;
    const exactBonus = (diff === 0) ? 70 : 0;

    points += accuracy + near3Bonus + rangeBonus + exactBonus;
    return { points, diff: ballsToOversDisplay(diff), rawDiff: diff, guess: predVal, isExact: diff === 0, mode: "Overs" };
  } else {
    // Defending/Score Scenario
    const actualScore = Number(actualResult);
    const predScore = Number(predVal || 0);
    const diff = Math.abs(actualScore - predScore);

    // 1st Innings points: Base calculation (max 120 based on diff)
    const base = Math.round(Math.max(0, 120 - (diff * 1.2)));
    const rangeBonusTier1 = (diff <= 5) ? 20 : 0;
    const rangeBonusTier2 = (diff <= 12) ? 10 : 0;
    const exactBonus = (diff === 0) ? 70 : 0;

    points += base + rangeBonusTier1 + rangeBonusTier2 + exactBonus;
    return { points, diff: `${diff} runs`, rawDiff: diff, guess: predScore, isExact: diff === 0, mode: "Score" };
  }
};

const resolveMatch = async () => {
  if (!isFirebaseConfigured || !db || !currentSettings) return;
  const is2nd = Boolean(currentMeta.secondInnings);
  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);

  let actualVal;
  let actualWinner;

  if (is2nd) {
    const chaserWon = document.querySelector('input[name="chaserWon"]:checked')?.value === "yes";
    const teamA = (currentMeta.teamA || "Team A").toString().toLowerCase();
    const teamB = (currentMeta.teamB || "Team B").toString().toLowerCase();

    // Better identification of winner
    let chasingTeam = teamB;
    let defendingTeam = teamA;
    if (currentMeta.disableScoreA && !currentMeta.disableScoreB) {
      chasingTeam = teamB; defendingTeam = teamA;
    } else if (currentMeta.disableScoreB && !currentMeta.disableScoreA) {
      chasingTeam = teamA; defendingTeam = teamB;
    }

    actualWinner = chaserWon ? chasingTeam : defendingTeam;
    actualVal = actualResultInput.value.trim();
    if (!actualVal) {
      alert("Please enter the Actual Result (Overs or Score).");
      return;
    }
  } else {
    actualVal = parseInt(actualScoreInput.value);
    if (isNaN(actualVal) || actualVal < 1) {
      alert("Please enter a valid actual score for the 1st innings.");
      return;
    }
  }

  try {
    calculatePointsButton.disabled = true;
    calculatePointsButton.textContent = "Calculating...";

    // Fetch all predictions once
    const snapshot = await getOnce(roomRef(roomId, "predictions"));
    const predData = snapshot.val() || {};
    const predictions = Object.values(predData);

    if (predictions.length === 0) {
      alert("No predictions found in this room.");
      calculatePointsButton.disabled = false;
      calculatePointsButton.textContent = "Resolve & View Rankings";
      return;
    }

    // Process points
    const results = Object.entries(predData).map(([cid, p]) => {
      const pResult = is2nd
        ? calculateInnings2Points(p, actualWinner, actualVal)
        : calculateInnings1Points(p, actualVal);

      return {
        clientId: cid,
        name: p.name || "Anonymous",
        ...pResult,
        originalPrediction: p
      };
    });

    // Sort Descending; for tied 0-point players, break tie by rawDiff ascending (closest prediction ranks higher)
    const sortedResults = [...results].sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (a.points === 0 && b.points === 0) {
        const aDiff = typeof a.rawDiff === 'number' ? a.rawDiff : Infinity;
        const bDiff = typeof b.rawDiff === 'number' ? b.rawDiff : Infinity;
        return aDiff - bDiff;
      }
      return 0;
    });
    lastResults = sortedResults;

    // Render Dashboard
    renderDashboard(sortedResults, actualVal, is2nd ? actualWinner : null);

    // Archive Results for Final Game Standings
    // We only archive locally so it shows in the dashboard
    // Permanent archival happens during "Prep 2nd Innings" or "End Match"

    calculatePointsButton.disabled = false;
    calculatePointsButton.textContent = is2nd ? "Resolve 2nd Innings" : "Resolve 1st Innings";
  } catch (error) {
    console.error(error);
    alert("Error resolving match scores.");
    calculatePointsButton.disabled = false;
    calculatePointsButton.textContent = "Resolve & View Rankings";
  }
};

const renderDashboard = (results, actual, winnerName = null) => {
  const is2nd = Boolean(currentMeta.secondInnings);

  // Format Actual Score label with winner if 2nd innings
  const winDisplay = winnerName ? `${winnerName.toString().toUpperCase()} WIN ` : "";
  resActualScoreLabel.textContent = is2nd ? `${winDisplay}(${actual})` : actual;

  resultsBody.innerHTML = results.map((r, i) => {
    let rankBadge = `<span class="rank-pill">${i + 1}</span>`;
    if (i === 0) rankBadge = `<span class="rank-pill rank-1">1</span>`;
    else if (i === 1) rankBadge = `<span class="rank-pill rank-2">2</span>`;
    else if (i === 2) rankBadge = `<span class="rank-pill rank-3">3</span>`;

    const exactBadge = r.isExact ? `<span class="exact-tag">EXACT!</span>` : "";

    return `
      <tr>
        <td>${rankBadge}</td>
        <td style="font-weight:700;">${escapeHtml(r.name)}</td>
        <td>${r.guess}</td>
        <td>${r.diff}</td>
        <td style="font-weight:800; font-size:16px;">${r.points}</td>
        <td>${exactBadge}</td>
      </tr>
    `;
  }).join("");

  resultsDashboard.classList.remove("hidden");
};

const downloadCSV = () => {
  if (lastResults.length === 0) return;

  const headers = ["Rank", "Name", "Guess", "Actual", "Diff", "Points"];
  const rows = lastResults.map((r, i) => [
    i + 1,
    r.name,
    r.guess,
    actualScoreInput.value,
    r.diff,
    r.points
  ]);

  const csvContent = [
    headers.join(","),
    ...rows.map(row => row.join(","))
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `Innings1_Results_${new Date().toLocaleDateString()}.csv`);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

calculatePointsButton.addEventListener("click", resolveMatch);
closeResultsButton.addEventListener("click", () => resultsDashboard.classList.add("hidden"));
exportCsvButton.addEventListener("click", downloadCSV);

clearPrep2ndButton.addEventListener("click", async () => {
  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);
  const is2nd = Boolean(currentMeta.secondInnings);
  const label = is2nd ? "2nd" : "1st";

  if (!confirm(`Finalize ${label} innings and archive results?`)) return;

  try {
    clearPrep2ndButton.disabled = true;
    clearPrep2ndButton.textContent = "Archiving...";

    // 1. Archive Results to History
    if (lastResults.length > 0) {
      const historyPayload = {};
      lastResults.forEach(r => {
        historyPayload[r.clientId || `legacy-${r.name}`] = {
          name: r.name,
          points: r.points,
          guess: r.guess,
          predictedWinner: r.originalPrediction?.predictedWinner || ""
        };
      });
      await saveInningsHistory(roomId, label, historyPayload);
    }

    // 2. Clear Live Predictions
    await clearRoomNode(roomId, "predictions");

    // 3. Automated Stage Transition (Sync to Firebase)
    if (!is2nd) {
      const nextMeta = getFormMeta();
      nextMeta.secondInnings = true;

      // Auto-Swap Batting Team: Flip from current batting team to the other
      const currentBattingHome = !currentMeta.disableScoreA;
      nextMeta.disableScoreA = currentBattingHome;
      nextMeta.disableScoreB = !currentBattingHome;

      await saveRoomMeta(roomId, nextMeta);
      alert("Results Archived! Stages switched and Batting Team swapped.");
    } else {
      alert("Match Finalized! View Final standings for full results.");
    }

    resultsDashboard.classList.add("hidden");
    actualScoreInput.value = "";
    actualResultInput.value = "";

    clearPrep2ndButton.disabled = false;
    clearPrep2ndButton.textContent = is2nd ? "Resolve Room" : "Prep 2nd Innings";
    updateResolutionVisibility();
  } catch (error) {
    console.error(error);
    alert("Error finalizing stage.");
    clearPrep2ndButton.disabled = false;
  }
});

loadInitialState();

// --- Final Match & Combined Scoring Logic ---


const calculateMatchFinals = (h1, h2) => {
  const combinedMap = new Map();

  const mergeRecords = (data, isInnings1) => {
    Object.entries(data).forEach(([cid, p]) => {
      const rawName = (p.name || "Anonymous").toString().trim();
      const key = rawName.toLowerCase();

      if (!combinedMap.has(key)) {
        combinedMap.set(key, {
          displayName: rawName,
          p1: { pts: 0, winner: "", guess: "---" },
          p2: { pts: 0, winner: "", guess: "---" }
        });
      }

      const rec = combinedMap.get(key);
      if (isInnings1) {
        rec.p1 = { pts: p.points || 0, winner: p.predictedWinner || "", guess: p.guess || "---" };
      } else {
        rec.p2 = { pts: p.points || 0, winner: p.predictedWinner || "", guess: p.guess || "---" };
      }
    });
  };

  mergeRecords(h1, true);
  mergeRecords(h2, false);

  return Array.from(combinedMap.values()).map(rec => {
    const p1 = rec.p1;
    const p2 = rec.p2;

    let penalty = 0;
    if (p1.winner && p2.winner && p1.winner.toLowerCase() !== p2.winner.toLowerCase()) {
      penalty = -20;
    }

    return {
      name: rec.displayName,
      p1Score: p1.pts,
      p1Winner: p1.winner,
      p1Guess: p1.guess,
      p2Score: p2.pts,
      p2Winner: p2.winner,
      p2Guess: p2.guess,
      penalty,
      total: Math.max(0, p1.pts + p2.pts + penalty)
    };
  });
};

const updateSeasonLeaderboard = async () => {
  // Now redirected to showSeasonStats() within the modal
};

let seasonSortMode = "total"; // "total" or "ppg"

window.showSeasonStats = async () => {
  if (!isFirebaseConfigured || !db || !currentSettings) return;
  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);

  // Active state in sidebar
  document.querySelectorAll(".match-item").forEach(el => el.classList.remove("active"));
  document.getElementById("item-season-stats")?.classList.add("active");

  matchDetail.innerHTML = `<div class="empty-state"><p>Calculating Season Standings...</p></div>`;

  try {
    const history = await getHistory(roomId);
    if (!history || Object.keys(history).length === 0) {
      matchDetail.innerHTML = `
        <div class="history-section">
          <div class="history-section-title">Season Rankings</div>
          <div class="empty-state"><p>No history data found in this room yet.</p></div>
        </div>
      `;
      return;
    }

    const seasonMap = new Map();
    Object.values(history).forEach(match => {
      const results = match.finalStandings || [];
      results.forEach(r => {
        const key = r.name.trim().toLowerCase();
        if (!seasonMap.has(key)) {
          seasonMap.set(key, { name: r.name, total: 0, matchCount: 0 });
        }
        const player = seasonMap.get(key);
        player.total += (r.total || 0);
        player.matchCount += 1;
      });
    });

    const players = Array.from(seasonMap.values()).map(p => ({
      ...p,
      ppg: Number((p.total / (p.matchCount || 1)).toFixed(2))
    }));

    const sorted = players.sort((a, b) => {
      if (seasonSortMode === "ppg") return b.ppg - a.ppg;
      return b.total - a.total;
    });

    matchDetail.innerHTML = `
      <div class="history-section">
        <div class="stats-header" style="flex-direction:column; align-items:flex-start; gap:10px;">
          <div class="history-section-title">Season Standings</div>
          <div class="season-sort-toggle">
            <div class="sort-item ${seasonSortMode === "total" ? "active" : ""}" onclick="window.setSeasonSort('total')">Total Points</div>
            <div class="sort-item ${seasonSortMode === "ppg" ? "active" : ""}" onclick="window.setSeasonSort('ppg')">Points Per Match</div>
          </div>
        </div>

        <table class="results-table">
          <thead>
            <tr>
              <th style="width:60px;">Rank</th>
              <th>Name</th>
              <th style="text-align:center;">Games</th>
              <th style="text-align:right;">${seasonSortMode === "ppg" ? "Avg PPG" : "Total Points"}</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map((s, i) => `
              <tr>
                <td>${i + 1}</td>
                <td>
                  <div style="font-weight:700;">${escapeHtml(s.name)}</div>
                  <div class="ppg-label">${s.ppg} pts/game</div>
                </td>
                <td style="text-align:center;">
                  <span class="match-badge">${s.matchCount}</span>
                </td>
                <td style="font-weight:800; font-size:18px; color:var(--accent-blue); text-align:right;">
                  ${seasonSortMode === "ppg" ? s.ppg : s.total}
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (error) {
    console.error(error);
    matchDetail.innerHTML = `<div class="empty-state"><p>Error loading history.</p></div>`;
  }
};

window.setSeasonSort = (mode) => {
  seasonSortMode = mode;
  showSeasonStats();
};

// --- DATA MIGRATION: RECALCULATE HISTORY ---
// Run this from the console: window.recalculateHistory()
window.recalculateHistory = async () => {
  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);
  if (!roomId) return console.error("No Room ID found.");

  // Data provided by the user for historical matches
  const manualResults = {
    "2026-03-28": { actual1st: 201, actual2nd: "15.4", winner: "rcb" },
    "2026-03-29": { actual1st: 220, actual2nd: "19.1", winner: "mi" },
    "2026-03-30": { actual1st: 127, actual2nd: "12.1", winner: "rr" },
    "2026-04-01": { actual1st: 141, actual2nd: "17.1", winner: "dc" }
  };

  console.log("Starting points recalculation...");
  try {
    const history = await getHistory(roomId);
    if (!history) return console.log("No history found.");

    for (const [dateKey, match] of Object.entries(history)) {
      // Find the results for this match
      // Try dateKey prefix (YYYY-MM-DD), then try stored matchResults
      const datePart = dateKey.split("_")[0];
      const res = manualResults[datePart] || match.matchResults;
      
      if (!res) {
        console.warn(`Skipping match ${dateKey}: No result data found.`);
        continue;
      }

      console.log(`Processing ${dateKey} (${match.matchTitle})...`);
      const m = JSON.parse(JSON.stringify(match)); // Deep clone
      
      // Determine context (Batting order)
      // Standard: Team A bats 1st, Team B bats 2nd
      const meta1 = { teamA: m.teamA, teamB: m.teamB, disableScoreA: false, disableScoreB: true, secondInnings: false };
      const meta2 = { teamA: m.teamA, teamB: m.teamB, disableScoreA: true, disableScoreB: false, secondInnings: true };

      const actualWinner = res.winner || res.actualWinner;
      const actual1st = res.actual1st;
      const actual2nd = res.actual2nd;
      const isOversMatch = actual2nd.toString().includes(".");

      // Recalculate Innings 1
      if (m.innings1) {
        for (const pid in m.innings1) {
          const p = m.innings1[pid];
          // Re-construct prediction object for scoring engine
          const pred = { scoreA: p.guess, scoreB: p.guess, predictedWinner: p.predictedWinner };
          const stats = calculateInnings1Points(pred, actual1st, meta1);
          m.innings1[pid] = { ...p, ...stats, points: stats.points };
        }
      }

      // Recalculate Innings 2
      if (m.innings2) {
        for (const pid in m.innings2) {
          const p = m.innings2[pid];
          const pred = { scoreA: p.guess, scoreB: p.guess, predictedWinner: p.predictedWinner };
          const stats = calculateInnings2Points(pred, actualWinner, actual2nd, meta2, isOversMatch);
          m.innings2[pid] = { ...p, ...stats, points: stats.points };
        }
      }

      // Update matchResults in record if missing (for future stability)
      if (!m.matchResults) {
        m.matchResults = { actual1st, actual2nd, actualWinner };
      }

      // Recalculate Final Standings
      m.finalStandings = calculateMatchFinals(m.innings1, m.innings2);

      // Save back
      await archiveToHistory(roomId, dateKey, m);
      console.log(`Successfully updated ${dateKey}`);
    }

    console.log("Recalculation Complete!");
    alert("All historical points have been recalculated using the new formula. Refreshing standings...");
    showSeasonStats();
  } catch (err) {
    console.error("Recalculation Failed:", err);
    alert(`Error: ${err.message}`);
  }
};

let editingMatchKey = null;

window.openEditMatch = (key) => {
  const match = fullHistory[key];
  if (!match) return;
  editingMatchKey = key;

  const res = match.matchResults || {};
  const dateStr = key.split("_")[0];

  editMatchTitle.value = match.matchTitle || "";
  editMatchDate.value = dateStr;
  editTeamA.value = match.teamA || "Team A";
  editTeamB.value = match.teamB || "Team B";
  editActual1st.value = res.actual1st || "";
  editActual2nd.value = res.actual2nd || "";

  document.getElementById("editLabelA").textContent = editTeamA.value;
  document.getElementById("editLabelB").textContent = editTeamB.value;

  const winner = (res.actualWinner || res.winner || "").toLowerCase();
  if (winner === editTeamA.value.toLowerCase()) editWinRadioA.checked = true;
  else if (winner === editTeamB.value.toLowerCase()) editWinRadioB.checked = true;

  editMatchModal.classList.remove("hidden");
};

const updateEditLabels = () => {
  document.getElementById("editLabelA").textContent = editTeamA.value || "Team A";
  document.getElementById("editLabelB").textContent = editTeamB.value || "Team B";
};

editTeamA.addEventListener("input", updateEditLabels);
editTeamB.addEventListener("input", updateEditLabels);

window.saveEditedMatch = async () => {
  if (!editingMatchKey) return;
  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);
  
  const title = editMatchTitle.value.trim();
  const date = editMatchDate.value;
  const teamA = editTeamA.value.trim();
  const teamB = editTeamB.value.trim();
  const actual1st = Number(editActual1st.value);
  const actual2nd = editActual2nd.value.trim();
  const winnerVal = document.querySelector('input[name="editWinner"]:checked')?.value;
  const actualWinner = (winnerVal === "a" ? teamA : teamB).toLowerCase();

  if (!title || !date || !teamA || !teamB || isNaN(actual1st) || !actual2nd || !winnerVal) {
    alert("Please fill all fields correctly.");
    return;
  }

  try {
    saveEditMatchBtn.disabled = true;
    saveEditMatchBtn.textContent = "Recalculating...";
    matchList.classList.add("loading");

    const originalRecord = fullHistory[editingMatchKey];
    if (!originalRecord) throw new Error("Original match record not found in memory.");

    // Store original names for prediction-to-slot matching logic
    const oldTeamA = (originalRecord.teamA || "Team A").toLowerCase();
    const oldTeamB = (originalRecord.teamB || "Team B").toLowerCase();

    const matchSnapshot = JSON.parse(JSON.stringify(originalRecord));
    matchSnapshot.matchTitle = title;
    matchSnapshot.teamA = teamA;
    matchSnapshot.teamB = teamB;
    matchSnapshot.matchResults = { actual1st, actual2nd, actualWinner };

    const meta1 = { teamA, teamB, disableScoreA: false, disableScoreB: true, secondInnings: false };
    const meta2 = { teamA, teamB, disableScoreA: true, disableScoreB: false, secondInnings: true };
    const isOversMatch = actual2nd.includes(".");

    // Helper to normalize the player's prediction to the NEW team names
    // This solves the issue where renaming teams broke historical point calculations
    const normalizePrediction = (p) => {
      let predWinner = (p.predictedWinner || "").toLowerCase();
      // If it matches the OLD Team A name, it's now meant for the NEW Team A slot
      if (predWinner === oldTeamA) predWinner = teamA.toLowerCase();
      else if (predWinner === oldTeamB) predWinner = teamB.toLowerCase();
      
      return {
        scoreA: p.guess, 
        scoreB: p.guess, 
        predictedWinner: predWinner 
      };
    };

    // Recalculate Innings 1
    if (matchSnapshot.innings1) {
      for (const pid in matchSnapshot.innings1) {
        const p = matchSnapshot.innings1[pid];
        const pred = normalizePrediction(p);
        const stats = calculateInnings1Points(pred, actual1st, meta1);
        matchSnapshot.innings1[pid] = { ...p, ...stats, points: stats.points };
      }
    }

    // Recalculate Innings 2
    if (matchSnapshot.innings2) {
      for (const pid in matchSnapshot.innings2) {
        const p = matchSnapshot.innings2[pid];
        const pred = normalizePrediction(p);
        const stats = calculateInnings2Points(pred, actualWinner, actual2nd, meta2, isOversMatch);
        matchSnapshot.innings2[pid] = { ...p, ...stats, points: stats.points };
      }
    }

    // Final standings refresh
    matchSnapshot.finalStandings = calculateMatchFinals(matchSnapshot.innings1, matchSnapshot.innings2);

    // Persistence Logic
    const oldDateKey = editingMatchKey;
    const newDateKey = `${date}_${oldDateKey.split("_")[1] || Date.now()}`;

    // Update Firebase
    if (oldDateKey !== newDateKey) {
      await archiveToHistory(roomId, newDateKey, matchSnapshot);
      await clearRoomNode(roomId, `history/${oldDateKey}`);
    } else {
      await archiveToHistory(roomId, oldDateKey, matchSnapshot);
    }

    // CRITICAL: Await the history refresh so fullHistory is updated before the modal closes
    console.log("Saving complete. refreshing history...");
    await openHistory(); 

    // Update local reference to the new key if it changed
    editingMatchKey = newDateKey;

    editMatchModal.classList.add("hidden");
    alert("Match updated and points recalculated!");
    
    // Select the match again to show latest results in detail view
    window.selectArchivedMatch(newDateKey);

  } catch (error) {
    console.error("Save Edit Failed:", error);
    alert("Error updating match: " + error.message);
  } finally {
    saveEditMatchBtn.disabled = false;
    saveEditMatchBtn.textContent = "Save & Recalculate";
    matchList.classList.remove("loading");
  }
};

cancelEditMatchBtn.addEventListener("click", () => editMatchModal.classList.add("hidden"));
saveEditMatchBtn.addEventListener("click", window.saveEditedMatch);

window.selectArchivedMatch = (key) => {
  const match = fullHistory[key];
  if (!match) return;

  // Active state
  document.querySelectorAll(".match-item").forEach(el => el.classList.remove("active"));
  document.getElementById(`item-${key}`)?.classList.add("active");

  const buildTable = (data, title) => {
    const rows = Object.values(data).sort((a, b) => (b.points || 0) - (a.points || 0));
    return `
      <div class="history-section">
        <div class="history-section-title">${title}</div>
        <table class="results-table">
          <thead>
            <tr><th>Name</th><th>Guess</th><th>Points</th></tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td style="font-weight:700;">${escapeHtml(r.name)}</td>
                <td>${r.guess}</td>
                <td style="font-weight:800;">${r.points}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  };

  const finalRows = [...(match.finalStandings || [])].sort((a, b) => (b.total || 0) - (a.total || 0));
  const finalTable = `
    <div class="history-section">
      <div class="history-section-title">Final Match Standings</div>
      <table class="results-table">
        <thead>
          <tr><th>Name</th><th>1st Inn</th><th>2nd Inn</th><th>Penalty</th><th>Total</th></tr>
        </thead>
        <tbody>
          ${finalRows.map(r => `
            <tr>
              <td style="font-weight:700;">${escapeHtml(r.name)}</td>
              <td>${r.p1Score}</td>
              <td>${r.p2Score}</td>
              <td>${r.penalty}</td>
              <td style="font-weight:800; font-size:16px; color:var(--accent-blue);">${r.total}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  matchDetail.innerHTML = `
    <div class="stats-header" style="margin-bottom:15px;">
      <div class="history-section-title" style="margin:0;">${escapeHtml(match.matchTitle)}</div>
    </div>
    <div class="history-grid">
      ${finalTable}
      ${buildTable(match.innings1 || {}, "1st Innings Rankings")}
      ${buildTable(match.innings2 || {}, "2nd Innings Rankings")}
    </div>
  `;
};

const viewFinalStandings = async () => {
  if (!isFirebaseConfigured || !db || !currentSettings) return;
  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);

  try {
    viewFinalStandingsButton.disabled = true;
    viewFinalStandingsButton.textContent = "Loading...";

    const history = await getInningsHistory(roomId);
    const overall = calculateMatchFinals(history["1st"] || {}, history["2nd"] || {});

    overall.sort((a, b) => b.total - a.total);
    lastOverallResults = overall;

    renderOverallDashboard(overall);
    viewFinalStandingsButton.disabled = false;
    viewFinalStandingsButton.textContent = "View Final Game Standings";
  } catch (error) {
    console.error(error);
    alert("Error fetching match standings. Have you resolved both innings?");
    viewFinalStandingsButton.disabled = false;
    viewFinalStandingsButton.textContent = "View Final Game Standings";
  }
};

const renderOverallDashboard = (results) => {
  overallMatchTitle.textContent = matchTitleInput.value || "T20 Match Series";
  overallBody.innerHTML = results.map((r, i) => {
    let rankBadge = `<span class="rank-pill">${i + 1}</span>`;
    if (i === 0) rankBadge = `<span class="rank-pill rank-1">1</span>`;
    else if (i === 1) rankBadge = `<span class="rank-pill rank-2">2</span>`;
    else if (i === 2) rankBadge = `<span class="rank-pill rank-3">3</span>`;

    const penaltyHtml = r.penalty < 0
      ? `<span class="penalty-minus">${r.penalty}</span>`
      : `<span style="color:var(--text-secondary);">0</span>`;

    return `
      <tr>
        <td>${rankBadge}</td>
        <td style="font-weight:700;">${escapeHtml(r.name)}</td>
        <td>
          <div class="summary-item"><label>Winner: ${r.p1Winner || '---'}</label><span>${r.p1Score} pts</span></div>
        </td>
        <td>
          <div class="summary-item"><label>Winner: ${r.p2Winner || '---'}</label><span>${r.p2Score} pts</span></div>
        </td>
        <td>${penaltyHtml}</td>
        <td style="font-weight:800; font-size:18px;">${r.total}</td>
      </tr>
    `;
  }).join("");

  overallDashboard.classList.remove("hidden");
};

const downloadOverallCSV = () => {
  if (lastOverallResults.length === 0) return;

  const headers = ["Rank", "Name", "1st Inn Guess", "1st Inn Winner", "1st Inn Pts", "2nd Inn Guess", "2nd Inn Winner", "2nd Inn Pts", "Penalty", "Final Total"];
  const rows = lastOverallResults.map((r, i) => [
    i + 1,
    r.name,
    r.p1Guess,
    r.p1Winner,
    r.p1Score,
    r.p2Guess,
    r.p2Winner,
    r.p2Score,
    r.penalty,
    r.total
  ]);

  const csvContent = [
    headers.join(","),
    ...rows.map(row => row.join(","))
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `FullMatch_FinalStandings_${new Date().toLocaleDateString()}.csv`);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

const handleEndMatch = async () => {
  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);
  if (!confirm("Are you sure you want to end the match? Current standings will be archived and the live room will be cleared.")) return;

  try {
    endMatchButton.disabled = true;
    endMatchButton.textContent = "Archiving...";

    // 1. Fetch current innings data
    const history = await getInningsHistory(roomId);
    const h1 = history["1st"] || {};
    const h2 = history["2nd"] || {};
    
    // 2. Calculate Final Standings
    const finalStandings = calculateMatchFinals(h1, h2);
    
    // 3. Save to Permanent History
    const dateKey = `${new Date().toISOString().split('T')[0]}_${Date.now()}`;
    const archivePayload = {
      matchTitle: matchTitleInput.value || "Unnamed Match",
      teamA: teamAInput.value || "Team A",
      teamB: teamBInput.value || "Team B",
      innings1: h1,
      innings2: h2,
      finalStandings: finalStandings,
      matchResults: {
        actual1st: Number(actualScoreInput.value),
        actual2nd: actualResultInput.value,
        actualWinner: document.querySelector('input[name="chaserWon"]:checked')?.value === "yes" ? (currentMeta.disableScoreA ? currentMeta.teamA : currentMeta.teamB) : (currentMeta.disableScoreA ? currentMeta.teamB : currentMeta.teamA)
      }
    };

    await archiveToHistory(roomId, dateKey, archivePayload);

    // 4. Wipe Match Data
    await wipeMatchData(roomId);

    overallDashboard.classList.add("hidden");
    alert("Match Data ARCHIVED and Live Room Reset.");
    location.reload();
  } catch (error) {
    console.error(error);
    alert("Error archiving match data.");
    endMatchButton.disabled = false;
    endMatchButton.textContent = "End Match & Wipe Data";
  }
};

// History Explorer Functions
const openHistory = async () => {
  if (!isFirebaseConfigured || !db || !currentSettings) return;
  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);

  historyDashboard.classList.remove("hidden");
  window.showSeasonStats(); // Default view

  try {
    const history = await getHistory(roomId);
    fullHistory = history || {};
    renderMatchList(fullHistory);
  } catch (error) {
    console.error(error);
  }
};

const renderMatchList = (history) => {
  const matches = Object.entries(history).sort((a, b) => b[0].localeCompare(a[0])); // Newest first

  if (matches.length === 0) {
    matchList.innerHTML = `<div class="panel-note">No archived matches found.</div>`;
    return;
  }

  matchList.innerHTML = matches.map(([key, match]) => {
    const dateStr = key.split("_")[0];
    return `
      <div class="match-item" onclick="window.selectArchivedMatch('${key}')" id="item-${key}" style="position:relative;">
        <div>
          <label>${dateStr}</label>
          <span>${escapeHtml(match.matchTitle)}</span>
        </div>
        <button class="edit-item-btn" onclick="event.stopPropagation(); window.openEditMatch('${key}')" title="Edit Match Results">✎</button>
      </div>
    `;
  }).join("");
};

window.selectArchivedMatch = (key) => {
  const match = fullHistory[key];
  if (!match) return;

  // Active state
  document.querySelectorAll(".match-item").forEach(el => el.classList.remove("active"));
  document.getElementById(`item-${key}`)?.classList.add("active");

  const buildTable = (data, title) => {
    const rows = Object.values(data).sort((a, b) => (b.points || 0) - (a.points || 0));
    return `
      <div class="history-section">
        <div class="history-section-title">${title}</div>
        <table class="results-table">
          <thead>
            <tr><th>Name</th><th>Guess</th><th>Points</th></tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td style="font-weight:700;">${escapeHtml(r.name)}</td>
                <td>${r.guess}</td>
                <td style="font-weight:800;">${r.points}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  };

  const finalRows = [...(match.finalStandings || [])].sort((a, b) => (b.total || 0) - (a.total || 0));
  const finalTable = `
    <div class="history-section">
      <div class="history-section-title">Final Match Standings</div>
      <table class="results-table">
        <thead>
          <tr><th>Name</th><th>1st Inn</th><th>2nd Inn</th><th>Penalty</th><th>Total</th></tr>
        </thead>
        <tbody>
          ${finalRows.map(r => `
            <tr>
              <td style="font-weight:700;">${escapeHtml(r.name)}</td>
              <td>${r.p1Score}</td>
              <td>${r.p2Score}</td>
              <td>${r.penalty}</td>
              <td style="font-weight:800; font-size:16px; color:var(--accent-blue);">${r.total}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  matchDetail.innerHTML = `
    <div class="history-grid">
      ${finalTable}
      ${buildTable(match.innings1 || {}, "1st Innings Rankings")}
      ${buildTable(match.innings2 || {}, "2nd Innings Rankings")}
    </div>
  `;
};

mainViewHistoryBtn.addEventListener("click", openHistory);
closeHistoryBtn.addEventListener("click", () => historyDashboard.classList.add("hidden"));

// Manual Entry Logic
const addManualRow = () => {
  if (!manualPlayersBody) return;
  const teamA = manTeamAInput.value.trim() || "Team A";
  const teamB = manTeamBInput.value.trim() || "Team B";

  const tr = document.createElement("tr");
  tr.className = "manual-player-row";
  tr.innerHTML = `
    <td><input type="text" class="m-name" placeholder="Name" /></td>
    <td><input type="number" class="m-p1-guess" placeholder="Guess" /></td>
    <td>
      <select class="m-winner">
        <option value="a">${escapeHtml(teamA)}</option>
        <option value="b">${escapeHtml(teamB)}</option>
      </select>
    </td>
    <td><input type="text" class="m-p2-guess" placeholder="Score/Ov" /></td>
    <td class="m-points-calc" style="color:var(--text-muted);">--</td>
    <td><button class="remove-row-btn">&times;</button></td>
  `;
  
  tr.querySelector(".remove-row-btn").onclick = () => tr.remove();
  manualPlayersBody.appendChild(tr);
};

const saveManualMatch = async () => {
  const dateStr = document.querySelector("#manualDate").value;
  const title = document.querySelector("#manualTitle").value.trim();
  const teamA = manTeamAInput.value.trim() || "Team A";
  const teamB = manTeamBInput.value.trim() || "Team B";
  const actual1st = Number(document.querySelector("#manualActual1st").value);
  const actualWinnerVal = document.querySelector('input[name="manualWinner"]:checked')?.value;
  const actual2nd = document.querySelector("#manualActual2nd").value.trim();

  const roomId = normalizeRoomId(roomIdInput.value.trim() || (currentSettings && currentSettings.roomId));

  if (!dateStr || !title || isNaN(actual1st) || !actual2nd) {
    alert("Please fill in all match setup fields.");
    return;
  }

  if (!roomId) {
    alert("Error: Room Identity is missing. Please enter a Room ID at the top of the page first.");
    return;
  }

  const actualWinner = (actualWinnerVal === "a" ? teamA : teamB).toLowerCase();
  
  // Construct dummy meta for scoring engine
  // We assume standard sequence: 1st batting is Team A (home), 2nd is Team B (away)
  const manualMeta = {
    teamA, teamB,
    disableScoreA: false, disableScoreB: true, // For 1st innings scoring context (A batting)
    secondInnings: false
  };

  const manualMeta2nd = {
    teamA, teamB,
    disableScoreA: true, disableScoreB: false, // For 2nd innings scoring context (B batting/chasing)
    secondInnings: true
  };

  const rows = document.querySelectorAll(".manual-player-row");
  if (rows.length === 0) {
    alert("Add at least one player.");
    return;
  }

  try {
    saveManualMatchBtn.disabled = true;
    saveManualMatchBtn.textContent = "Calculating...";

    const innings1 = {};
    const innings2 = {};

    rows.forEach((row, i) => {
      const name = row.querySelector(".m-name").value.trim() || `Player ${i+1}`;
      const p1Guess = Number(row.querySelector(".m-p1-guess").value);
      const winChoice = row.querySelector(".m-winner").value;
      const p2Guess = row.querySelector(".m-p2-guess").value.trim();
      
      const predWinner = winChoice === "a" ? teamA : teamB;
      const isOversMatch = actual2nd.includes(".");

      // Score Innings 1
      const p1Pred = { scoreA: p1Guess, predictedWinner: predWinner };
      const p1Stats = calculateInnings1Points(p1Pred, actual1st, manualMeta);
      innings1[name] = { name, ...p1Stats, points: p1Stats.points, guess: p1Guess, predictedWinner: predWinner };

      // Score Innings 2
      // We pass both scoreA and scoreB to be safe, calculation logic will pick correct one
      const p2Pred = { scoreA: p2Guess, scoreB: p2Guess, predictedWinner: predWinner };
      const p2Stats = calculateInnings2Points(p2Pred, actualWinner, actual2nd, manualMeta2nd, isOversMatch);
      innings2[name] = { name, ...p2Stats, points: p2Stats.points, guess: p2Guess, predictedWinner: predWinner };
    });

    const finalStandings = calculateMatchFinals(innings1, innings2);
    const dateKey = `${dateStr.replace(/[^a-zA-Z0-9]/g, '-')}_MANUAL_${Date.now()}`;
    const archivePayload = {
      matchTitle: title,
      teamA, teamB,
      innings1,
      innings2,
      finalStandings,
      matchResults: {
        actual1st,
        actual2nd,
        actualWinner
      }
    };

    const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);
    await archiveToHistory(roomId, dateKey, archivePayload);
    
    alert("Manual Match Archived Successfully!");
    manualEntryDashboard.classList.add("hidden");
    updateSeasonLeaderboard();
  } catch (error) {
    console.error("Manual Save Error:", error);
    alert(`Error saving manual match: ${error.message}`);
  } finally {
    saveManualMatchBtn.disabled = false;
    saveManualMatchBtn.textContent = "Calculate & Archive Match";
  }
};

showManualEntryBtn.addEventListener("click", () => {
  manualPlayersBody.innerHTML = "";
  addManualRow();
  manualEntryDashboard.classList.remove("hidden");
});

closeManualEntryBtn.addEventListener("click", () => manualEntryDashboard.classList.add("hidden"));
cancelManualSaveBtn.addEventListener("click", () => manualEntryDashboard.classList.add("hidden"));
addManualRowBtn.addEventListener("click", addManualRow);

const updateManualTeamLabels = () => {
  const teamA = manTeamAInput.value.trim() || "Team A";
  const teamB = manTeamBInput.value.trim() || "Team B";
  
  // 1. Update Winner radios
  const labelA = document.getElementById("manWinALabel");
  const labelB = document.getElementById("manWinBLabel");
  if (labelA) labelA.textContent = teamA;
  if (labelB) labelB.textContent = teamB;

  // 2. Update existing rows
  document.querySelectorAll(".manual-player-row").forEach(row => {
    const select = row.querySelector(".m-winner");
    if (select) {
      select.options[0].text = teamA;
      select.options[1].text = teamB;
    }
  });
};

manTeamAInput.addEventListener("input", updateManualTeamLabels);
manTeamBInput.addEventListener("input", updateManualTeamLabels);

saveManualMatchBtn.addEventListener("click", saveManualMatch);

viewFinalStandingsButton.addEventListener("click", viewFinalStandings);
endMatchButton.addEventListener("click", handleEndMatch);
exportCsvButton.addEventListener("click", downloadCSV);
exportOverallCsvButton.addEventListener("click", downloadOverallCSV);
closeOverallButton.addEventListener("click", () => overallDashboard.classList.add("hidden"));

// --- DATA UTILITIES (Run from Console) ---
window.renamePlayer = async (oldName, newName) => {
  if (!oldName || !newName) return console.error("Usage: renamePlayer('Old', 'New')");
  const roomId = normalizeRoomId(roomIdInput.value.trim() || currentSettings.roomId);
  if (!roomId) return console.error("No Room ID found.");
  
  console.log(`Renaming '${oldName}' to '${newName}' in room: ${roomId}...`);
  try {
    const history = await getHistory(roomId);
    if (!history) return console.log("No history found.");

    let updateCount = 0;
    for (const [dateKey, match] of Object.entries(history)) {
      let changed = false;
      const m = JSON.parse(JSON.stringify(match));

      const processNode = (obj) => {
        if (!obj) return;
        if (obj[oldName]) {
          const data = obj[oldName];
          data.name = newName;
          obj[newName] = data;
          delete obj[oldName];
          changed = true;
        }
      };

      processNode(m.innings1);
      processNode(m.innings2);
      if (m.finalStandings) {
        m.finalStandings.forEach(r => {
          if (r.name === oldName) { r.name = newName; changed = true; }
        });
      }

      if (changed) {
        await archiveToHistory(roomId, dateKey, m);
        updateCount++;
        console.log(`Updated match: ${dateKey}`);
      }
    }

    console.log(`Migration Complete. Updated ${updateCount} matches.`);
    alert(`Success: '${oldName}' renamed to '${newName}' in ${updateCount} matches.`);
    showSeasonStats();
  } catch (err) {
    console.error("Migration Failed:", err);
    alert(`Migration error: ${err.message}`);
  }
};
