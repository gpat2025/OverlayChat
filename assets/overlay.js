import {
  db,
  isFirebaseConfigured,
  limitToLast,
  onValue,
  query,
  removeChatMessage,
  removePrediction,
  roomRef
} from "./firebase.js";
import {
  getAudienceEntryUrl,
  escapeHtml,
  getRoomId,
  setHidden,
  sortByTimestampDescending,
  applyTeamTheme,
  getTeamLogoPath
} from "./shared.js";

const params = new URLSearchParams(window.location.search);
const isDesktopMode = params.get("mode") === "desktop";
const roomId = getRoomId();
const overlayWidget = document.querySelector("#overlayWidget");
const overlayDragHandle = document.querySelector("#overlayDragHandle");
const audienceUrlLabel = document.querySelector("#audienceUrlLabel");
const audienceCodeLabel = document.querySelector("#audienceCodeLabel");
const joinCopyButton = document.querySelector("#joinCopyButton");
const predictionCards = document.querySelector("#predictionCards");
const overlayChatFeed = document.querySelector("#overlayChatFeed");
const predictionCount = document.querySelector("#predictionCount");
const setupNotice = document.querySelector("#overlaySetupNotice");
const winnerTally = document.querySelector("#winnerTally");
const teamALabel = document.querySelector("#teamALabel");
const teamBLabel = document.querySelector("#teamBLabel");
const graphPercent = document.querySelector("#graphPercent");
const graphFill = document.querySelector("#graphFill");

const overlayPositionKey = `overlaychat-overlay-position-${roomId}`;
const defaultPosition = { left: 24, top: 24 };

let currentPredictions = [];
let currentMeta = {};

document.body.classList.toggle("desktop-embed", isDesktopMode);
if (isDesktopMode) {
  document.documentElement.classList.add("desktop-embed", "overlay-shell");
}
audienceUrlLabel.textContent = getAudienceEntryUrl().replace(/^https?:\/\//, "");
audienceCodeLabel.textContent = `Code: ${roomId.toUpperCase()}`;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const formatRelativeTime = (timestamp) => {
  if (!timestamp) {
    return "just now";
  }

  const diffMs = Math.max(0, Date.now() - Number(timestamp));
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes < 1) {
    return "just now";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
};

const copyJoinLink = async () => {
  const value = getAudienceEntryUrl();

  try {
    if (window.overlayDesktop?.copyText) {
      await window.overlayDesktop.copyText(value);
    } else {
      await navigator.clipboard.writeText(value);
    }

    audienceCodeLabel.textContent = `Copied: ${roomId.toUpperCase()}`;
    window.setTimeout(() => {
      audienceCodeLabel.textContent = `Code: ${roomId.toUpperCase()}`;
    }, 1400);
  } catch (error) {
    console.error(error);
    audienceCodeLabel.textContent = "Copy failed";
    window.setTimeout(() => {
      audienceCodeLabel.textContent = `Code: ${roomId.toUpperCase()}`;
    }, 1400);
  }
};

joinCopyButton?.addEventListener("click", copyJoinLink);

const saveOverlayPosition = (position) => {
  localStorage.setItem(overlayPositionKey, JSON.stringify(position));
};

const getSavedOverlayPosition = () => {
  try {
    const raw = localStorage.getItem(overlayPositionKey);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error(error);
    return null;
  }
};

const getOverlayBounds = () => {
  const width = overlayWidget.offsetWidth;
  const height = overlayWidget.offsetHeight;
  return {
    maxLeft: Math.max(0, window.innerWidth - width),
    maxTop: Math.max(0, window.innerHeight - height)
  };
};

const applyOverlayPosition = (position) => {
  const { maxLeft, maxTop } = getOverlayBounds();
  const left = clamp(position.left, 0, maxLeft);
  const top = clamp(position.top, 0, maxTop);
  overlayWidget.style.left = `${left}px`;
  overlayWidget.style.top = `${top}px`;
  saveOverlayPosition({ left, top });
};

const restoreOverlayPosition = () => {
  const saved = getSavedOverlayPosition();
  applyOverlayPosition(saved || defaultPosition);
};

const enableDragging = () => {
  let dragState = null;

  overlayDragHandle.addEventListener("pointerdown", (event) => {
    const rect = overlayWidget.getBoundingClientRect();
    dragState = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      pointerId: event.pointerId
    };

    overlayWidget.classList.add("dragging");
    overlayDragHandle.setPointerCapture(event.pointerId);
  });

  overlayDragHandle.addEventListener("pointermove", (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }

    applyOverlayPosition({
      left: event.clientX - dragState.offsetX,
      top: event.clientY - dragState.offsetY
    });
  });

  const stopDragging = (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) {
      return;
    }

    overlayWidget.classList.remove("dragging");
    overlayDragHandle.releasePointerCapture(event.pointerId);
    dragState = null;
  };

  overlayDragHandle.addEventListener("pointerup", stopDragging);
  overlayDragHandle.addEventListener("pointercancel", stopDragging);
};

if (!isDesktopMode) {
  window.addEventListener("resize", restoreOverlayPosition);
  restoreOverlayPosition();
  enableDragging();
}

const isAdminMode = isDesktopMode || params.get("admin") === "true";

const adminActionMarkup = (type, id) =>
  isAdminMode
    ? `<button class="overlay-admin-remove" type="button" data-remove-type="${type}" data-remove-id="${escapeHtml(id)}">Remove</button>`
    : "";

const renderPredictions = (predictions) => {
  const getSortedPredictions = (list, meta) => {
    if (meta.predictionSort !== "score") {
      return sortByTimestampDescending(list, "updatedAt");
    }

    const teamA = (meta.teamA || "Team A").toString().trim();
    const teamB = (meta.teamB || "Team B").toString().trim();
    const is2ndInnings = Boolean(meta.secondInnings);
    
    let chasingTeam = null;
    if (is2ndInnings) {
      if (meta.disableScoreA && !meta.disableScoreB) chasingTeam = teamB;
      else if (meta.disableScoreB && !meta.disableScoreA) chasingTeam = teamA;
    }

    return [...list].sort((a, b) => {
      const getValue = (p) => {
        const is2ndInnings = Boolean(meta.secondInnings);
        const teamA = (meta.teamA || "Team A").toString().trim();
        const teamB = (meta.teamB || "Team B").toString().trim();
        
        let chasingTeam = null;
        if (is2ndInnings) {
          if (meta.disableScoreA && !meta.disableScoreB) chasingTeam = teamB;
          else if (meta.disableScoreB && !meta.disableScoreA) chasingTeam = teamA;
        }

        let val = 0;
        if (is2ndInnings && chasingTeam) {
          // In 2nd innings, always use the chasing team's field
          const lowChaser = chasingTeam.toLowerCase();
          const lowA = teamA.toLowerCase();
          if (lowChaser === lowA) val = Number(p.scoreA) || 0;
          else val = Number(p.scoreB) || 0;
        } else {
          // 1st Innings logic
          const hasA = !meta.disableScoreA;
          const hasB = !meta.disableScoreB;
          
          if (hasA && !hasB) {
            val = Number(p.scoreA) || 0;
          } else if (hasB && !hasA) {
            val = Number(p.scoreB) || 0;
          } else {
            // Both active (rare in 1st innings) or both disabled: use predicted winner's score
            const winner = (p.predictedWinner || "").toString().trim().toLowerCase();
            const lowA = teamA.toLowerCase();
            const lowB = teamB.toLowerCase();
            
            if (winner === lowA) val = Number(p.scoreA) || 0;
            else if (winner === lowB) val = Number(p.scoreB) || 0;
            else val = Math.max(Number(p.scoreA) || 0, Number(p.scoreB) || 0);
          }
        }

        // Put zero/null scores at the end of the sort
        return val === 0 ? Infinity : val;
      };

      const valA = getValue(a);
      const valB = getValue(b);
      
      if (valA === valB) return (b.updatedAt || 0) - (a.updatedAt || 0);
      return valA - valB; // Ascending: lowest first, fastest first
    });
  };

  const sorted = getSortedPredictions(predictions, currentMeta);
  const recent = sorted.slice(0, 15);
  predictionCount.textContent = `${predictions.length} live`;

  if (!recent.length) {
    predictionCards.innerHTML = `<div class="empty-state overlay-empty">Predictions will appear here.</div>`;
    winnerTally.innerHTML = "";
    return;
  }

  winnerTally.innerHTML = "";
  predictionCards.innerHTML = recent
    .map((prediction) => {
      const teamAName = (currentMeta.teamA || "Team A").trim();
      const teamBName = (currentMeta.teamB || "Team B").trim();

      const isTeamA = prediction.predictedWinner === teamAName;
      const isTeamB = prediction.predictedWinner === teamBName;
      const sideClass = isTeamA ? "team-a-highlight" : (isTeamB ? "team-b-highlight" : "");

      let displayScore = "";
      const hasScoreA = prediction.scoreA !== null && prediction.scoreA !== undefined;
      const hasScoreB = prediction.scoreB !== null && prediction.scoreB !== undefined;

      if (hasScoreA || hasScoreB) {
        const teamA = (currentMeta.teamA || "Home Team").toString().trim();
        const teamB = (currentMeta.teamB || "Away Team").toString().trim();
        const is2ndInnings = Boolean(currentMeta.secondInnings);

        const lowA = teamA.toLowerCase();
        const lowB = teamB.toLowerCase();

        // Infer chasing team:
        let chasingTeam = null;
        if (is2ndInnings) {
          if (currentMeta.disableScoreA && !currentMeta.disableScoreB) chasingTeam = teamB;
          else if (currentMeta.disableScoreB && !currentMeta.disableScoreA) chasingTeam = teamA;
        }

        const lowChaser = (chasingTeam || "").toLowerCase();
        const predictedWinner = (prediction.predictedWinner || "").toString().trim().toLowerCase();
        const isChasingWinner = lowChaser && predictedWinner === lowChaser;

        const scores = [];
        if (hasScoreA) {
          const sA = prediction.scoreA;
          const isAChaser = lowChaser === lowA;
          const isOver = is2ndInnings && isAChaser && isChasingWinner;
          
          // Requirement: Hide 1st innings score (non-chaser) when in 2nd innings
          if (!is2ndInnings || isAChaser) {
            const suffix = isOver ? " ov" : "";
            const displayVal = isOver ? (Number(sA) || 0).toFixed(1) : sA;
            scores.push(`<span class="team-a-highlight">${escapeHtml(teamAName)}: ${displayVal}${suffix}</span>`);
          }
        }
        if (hasScoreB) {
          const sB = prediction.scoreB;
          const isBChaser = lowChaser === lowB;
          const isOver = is2ndInnings && isBChaser && isChasingWinner;

          // Requirement: Hide 1st innings score (non-chaser) when in 2nd innings
          if (!is2ndInnings || isBChaser) {
            const suffix = isOver ? " ov" : "";
            const displayVal = isOver ? (Number(sB) || 0).toFixed(1) : sB;
            scores.push(`<span class="team-b-highlight">${escapeHtml(teamBName)}: ${displayVal}${suffix}</span>`);
          }
        }
        displayScore = scores.join('<span class="score-divider">-</span>');
      } else {
        displayScore = escapeHtml(prediction.predictedScore || "");
      }

      const winnerLogo = getTeamLogoPath(prediction.predictedWinner);
      const winnerLogoHtml = winnerLogo ? `<img src="${winnerLogo}" class="team-logo-inline" alt="" />` : "";

      return `
        <article class="prediction-card compact multi-line">
          ${adminActionMarkup("prediction", prediction.clientId)}
          <div class="prediction-card-header">
            <span class="prediction-name">${escapeHtml(prediction.name)}</span>
            <span class="card-time">${formatRelativeTime(prediction.updatedAt)}</span>
          </div>
          <div class="prediction-card-main">
            <div class="prediction-val">${displayScore}</div>
            <span class="prediction-side ${sideClass}">
              ${winnerLogoHtml}
            </span>
          </div>
        </article>
      `;
    })
    .join("");
};

const updateGraph = () => {
  const teamA = (currentMeta.teamA || "Team A").trim();
  const teamB = (currentMeta.teamB || "Team B").trim();
  
  const logoA = getTeamLogoPath(teamA);
  const logoB = getTeamLogoPath(teamB);
  
  teamALabel.innerHTML = logoA ? `<img src="${logoA}" class="team-logo-inline" alt="" /> ${escapeHtml(teamA)}` : escapeHtml(teamA);
  teamBLabel.innerHTML = logoB ? `${escapeHtml(teamB)} <img src="${logoB}" class="team-logo-inline" alt="" />` : escapeHtml(teamB);

  if (!currentPredictions.length) {
    graphFill.style.width = "50%";
    graphPercent.textContent = "0% / 0%";
    return;
  }

  const clean = (s) => (s || "").toString().trim().toLowerCase();
  const cA = clean(teamA);
  const cB = clean(teamB);

  const countA = currentPredictions.filter(p => clean(p.predictedWinner) === cA).length;
  const countB = currentPredictions.filter(p => clean(p.predictedWinner) === cB).length;
  const total = countA + countB;

  if (total === 0) {
    graphFill.style.width = "50%";
    graphPercent.textContent = "50% / 50%";
    return;
  }

  const percentA = Math.round((countA / total) * 100);
  const percentB = 100 - percentA;

  graphFill.style.width = `${percentA}%`;
  graphPercent.textContent = `${percentA}% / ${percentB}%`;
};

const renderChat = (messages) => {
  const recentMessages = sortByTimestampDescending(messages, "createdAt").slice(0, 5);

  if (!recentMessages.length) {
    overlayChatFeed.innerHTML = `<div class="empty-state overlay-empty">Chat will appear here.</div>`;
    return;
  }

  overlayChatFeed.innerHTML = recentMessages
    .map(
      (message) => `
        <article class="overlay-message">
          ${adminActionMarkup("chat", message.id)}
          <div class="chat-message-header">
            <strong>${escapeHtml(message.name)}</strong>
            <span class="card-time">${formatRelativeTime(message.createdAt)}</span>
          </div>
          <p>${escapeHtml(message.message)}</p>
        </article>
      `
    )
    .join("");
};

const handleOverlayAdminClick = async (event) => {
  const button = event.target.closest(".overlay-admin-remove");
  if (!button) {
    return;
  }

  const removeType = button.dataset.removeType;
  const removeId = button.dataset.removeId;
  const path = `rooms/${roomId}/${removeType === "prediction" ? "predictions" : "chat"}/${removeId}`;

  console.log(`[Admin] Attempting to remove ${removeType}: ${removeId}`);
  console.log(`[Admin] Full database path: ${path}`);

  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Removing...";

  try {
    if (removeType === "prediction") {
      await removePrediction(roomId, removeId);
      console.log(`[Admin] Successfully removed prediction: ${removeId}`);
    } else if (removeType === "chat") {
      await removeChatMessage(roomId, removeId);
      console.log(`[Admin] Successfully removed chat message: ${removeId}`);
    }
  } catch (error) {
    console.error(`[Admin] Failed to remove ${removeType}:`, error);
    
    // Provide visual feedback for permission issues
    const isPermissionError = error.message?.includes("PERMISSION_DENIED");
    const errorMsg = isPermissionError 
      ? `Permission Denied: Ensure your Firebase rules allow deleting from "${path}"`
      : `Failed to remove: ${error.message}`;
    
    alert(errorMsg);
    
    button.disabled = false;
    button.textContent = "Retry";
  }
};

predictionCards.addEventListener("click", handleOverlayAdminClick);
overlayChatFeed.addEventListener("click", handleOverlayAdminClick);

if (!isFirebaseConfigured || !db) {
  setHidden(setupNotice, false);
} else {
  onValue(roomRef(roomId, "predictions"), (snapshot) => {
    const entries = snapshot.val() || {};
    const predictions = Object.entries(entries).map(([id, value]) => ({
      clientId: id,
      ...value
    }));
    currentPredictions = predictions;
    renderPredictions(predictions);
    updateGraph();
  });

  onValue(roomRef(roomId, "meta"), (snapshot) => {
    const meta = snapshot.val() || {};
    currentMeta = meta;
    document.body.classList.toggle("chat-hidden", !!meta.hideChat);
    document.body.classList.toggle("join-hidden", !!meta.hideJoin);
    applyTeamTheme(meta.teamA, meta.teamB);
    updateGraph();
    if (currentPredictions && currentPredictions.length > 0) {
      renderPredictions(currentPredictions);
    }
  });

  onValue(query(roomRef(roomId, "chat"), limitToLast(5)), (snapshot) => {
    const entries = snapshot.val() || {};
    const messages = Object.entries(entries).map(([id, value]) => ({
      id,
      ...value
    }));
    renderChat(messages);
  });
}
