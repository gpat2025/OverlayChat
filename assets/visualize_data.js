import { escapeHtml, sortHistoryLatestFirst } from "./shared.js";

let _history = {};
let _standings = [];

// Close functionality
export const closeAllVizModals = () => {
  document.getElementById("playerProfileModal")?.classList.add("hidden");
  document.getElementById("playerListModal")?.classList.add("hidden");
  document.getElementById("playerTrendModal")?.classList.add("hidden");
  document.getElementById("compareModal")?.classList.add("hidden");
  document.body.style.overflow = "";
};

// Handle Esc Key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllVizModals();
});

const setupModalClose = (modal) => {
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeAllVizModals();
  });
  const closeBtn = modal.querySelector(".close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeAllVizModals);
  }
};

// ----------------- DATA COMPUTATION ----------------- //

export const computePlayerStats = (playerName, history) => {
  const nameKey = playerName.trim().toLowerCase();
  
  // Sort history chronologically (oldest first)
  const matches = Object.entries(history || {}).sort((a, b) => {
    // Assuming id like "2026-04-11_matchId"
    return a[0].localeCompare(b[0]);
  });

  const stats = {
    name: playerName,
    totalPoints: 0,
    gamesParticipated: 0,
    bestMatchTotal: -1,
    bestMatchId: null,
    bestMatchTitle: null,
    
    p1Total: 0,
    p2Total: 0,
    p2CorrectWinnerTotal: 0,
    p2CorrectWinnerCount: 0,
    
    totalCorrectPicks: 0,
    bothInningsCorrectCount: 0,
    
    gold: 0,
    silver: 0,
    bronze: 0,
    
    exactPredictions: 0,
    penalties: 0,
    
    matchSeries: [] // per-match data for charts
  };

  matches.forEach(([matchId, mData]) => {
    const standings = mData.finalStandings || [];
    const playerRecord = standings.find(s => (s.name || "").trim().toLowerCase() === nameKey);
    
    if (playerRecord) { // Participant
      stats.gamesParticipated++;
      stats.totalPoints += playerRecord.total;
      
      if (playerRecord.total > stats.bestMatchTotal) {
        stats.bestMatchTotal = playerRecord.total;
        stats.bestMatchId = matchId;
        stats.bestMatchTitle = mData.matchTitle;
      }

      stats.p1Total += (Number(playerRecord.p1Score) || 0);
      stats.p2Total += (Number(playerRecord.p2Score) || 0);
      
      let p1Correct = false;
      let p2Correct = false;

      // Note: "Score" points in our engine can be 200 max. "Overs/Score" for 2nd inn max is 220 in some cases, or 200.
      if (playerRecord.p1Score >= 200) stats.exactPredictions++;
      if (playerRecord.p2Score >= 200) stats.exactPredictions++;
      
      if (playerRecord.penalty === -20) {
        stats.penalties++;
      }

      // Hack for winner inference: If points > 0, they usually got the winner right.
      // But we have actual `p1Winner` and `p2Winner` fields if they correctly matched vs meta.
      // Since we don't have meta here, we can infer: >0 pts means correct winner pick for that inn.
      if ((Number(playerRecord.p1Score) || 0) > 0) {
        p1Correct = true;
        stats.totalCorrectPicks++;
      }
      if ((Number(playerRecord.p2Score) || 0) > 0) {
        p2Correct = true;
        stats.totalCorrectPicks++;
        
        stats.p2CorrectWinnerTotal += (Number(playerRecord.p2Score) || 0);
        stats.p2CorrectWinnerCount++;
      }
      
      if (p1Correct && p2Correct && playerRecord.penalty === 0) {
        stats.bothInningsCorrectCount++;
      }
      
      // Medals
      const sortedSt = [...standings].sort((a,b) => b.total - a.total);
      const rankIndex = sortedSt.findIndex(s => (s.name || "").trim().toLowerCase() === nameKey);
      let matchMedal = null;
      if (rankIndex === 0) { stats.gold++; matchMedal = "gold"; }
      else if (rankIndex === 1) { stats.silver++; matchMedal = "silver"; }
      else if (rankIndex === 2) { stats.bronze++; matchMedal = "bronze"; }

      stats.matchSeries.push({
        matchId,
        matchTitle: mData.matchTitle || matchId,
        played: true,
        total: playerRecord.total,
        p1Score: Number(playerRecord.p1Score) || 0,
        p2Score: Number(playerRecord.p2Score) || 0,
        penalty: playerRecord.penalty || 0,
        medal: matchMedal
      });
      
    } else {
      // Missed match
      stats.matchSeries.push({
        matchId,
        matchTitle: mData.matchTitle || matchId,
        played: false,
        total: 0,
        p1Score: 0,
        p2Score: 0,
        penalty: 0
      });
    }
  });

  return {
    ...stats,
    ppg: stats.gamesParticipated > 0 ? (stats.totalPoints / stats.gamesParticipated).toFixed(1) : 0,
    p1Avg: stats.gamesParticipated > 0 ? (stats.p1Total / stats.gamesParticipated).toFixed(1) : 0,
    p2AvgAll: stats.gamesParticipated > 0 ? (stats.p2Total / stats.gamesParticipated).toFixed(1) : 0,
    p2AvgCorrect: stats.p2CorrectWinnerCount > 0 ? (stats.p2CorrectWinnerTotal / stats.p2CorrectWinnerCount).toFixed(1) : 0,
    winPercent: stats.gamesParticipated > 0 ? ((stats.totalCorrectPicks / (stats.gamesParticipated * 2)) * 100).toFixed(0) : 0,
    penaltyRate: stats.gamesParticipated > 0 ? ((stats.penalties / stats.gamesParticipated) * 100).toFixed(0) : 0
  };
};

// ----------------- SVG DRAWING ----------------- //

const VIZ_COLORS = ["#007AFF", "#34C759", "#FF9500", "#FF2D55", "#AF52DE", "#5856D6"];

const renderSvgLineGraph = (container, seriesArray, mode = "cumulative", hiddenIndices = new Set()) => {
  if (!seriesArray || seriesArray.length === 0) return;
  const W = container.clientWidth || 700;
  const H = container.clientHeight || 250;
  const padTop = 20, padBottom = 20, padSides = 20;
  
  // Filter active series
  const activeSeries = seriesArray.filter((s, i) => !hiddenIndices.has(i));
  
  // Prepare processed points for ALL series (to keep axis stable)
  // But we'll only DRAW the active ones
  const allSeriesData = seriesArray.map((s, sIdx) => {
    let pts = [];
    let currentCum = 0;
    const color = s.color || VIZ_COLORS[sIdx % VIZ_COLORS.length];
    
    s.matchData.forEach((m, idx) => {
      currentCum += m.total;
      pts.push({
        x: 0, y: 0,
        val: mode === "cumulative" ? currentCum : m.total,
        label: m.matchTitle,
        playerName: s.playerName,
        color: color,
        detail: mode === "cumulative" ? `Total: ${currentCum}` : `Pts: ${m.total}`
      });
    });
    return { playerName: s.playerName, color, pts, isActive: !hiddenIndices.has(sIdx), sIdx };
  });

  // Global Max across all series (including hidden ones to keep scale stable)
  const allPtsFlat = allSeriesData.flatMap(s => s.pts);
  const maxVal = Math.max(1, ...allPtsFlat.map(p => p.val));
  
  const widthArea = W - padSides * 2;
  const heightArea = H - padTop - padBottom;
  
  // Coordinates
  allSeriesData.forEach(s => {
    s.pts.forEach((p, i) => {
      p.x = padSides + (i * (widthArea / Math.max(1, (s.pts.length - 1))));
      p.y = padTop + heightArea - ((p.val / maxVal) * heightArea);
    });
  });

  let svgContentHtml = '';
  allSeriesData.forEach((s) => {
    if (!s.isActive) return;

    let polylineStr = "";
    let pathStr = "";
    
    if (s.pts.length > 0) {
      pathStr = `M ${s.pts[0].x},${H - padBottom} `;
      s.pts.forEach((p) => {
        polylineStr += `${p.x},${p.y} `;
        pathStr += `L ${p.x},${p.y} `;
      });
      pathStr += `L ${s.pts[s.pts.length-1].x},${H - padBottom} Z`;
      
      const gradId = `lineGrad_${s.sIdx}`;
      svgContentHtml += `
        <g class="viz-series-group" data-player="${escapeHtml(s.playerName)}">
          <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${s.color}" stop-opacity="0.2" />
              <stop offset="100%" stop-color="${s.color}" stop-opacity="0" />
            </linearGradient>
          </defs>
          <path class="viz-series-area" d="${pathStr}" fill="url(#${gradId})" />
          <polyline class="viz-series-line" points="${polylineStr.trim()}" fill="none" stroke="${s.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          ${s.pts.map((p, i) => `
            <circle cx="${p.x}" cy="${p.y}" r="4" fill="var(--app-bg-solid)" stroke="${p.color}" stroke-width="2" class="chart-point" data-all-idx="${i}" data-series-idx="${s.sIdx}" />
          `).join("")}
        </g>
      `;
    }
  });

  const svgHtml = `
    <svg class="viz-svg-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${svgContentHtml}
    </svg>
    <div id="chartTooltip" class="viz-chart-tooltip" style="opacity:0"></div>
  `;
  container.innerHTML = svgHtml;

  // Hover mechanics
  const tooltip = container.querySelector("#chartTooltip");
  const circles = container.querySelectorAll(".chart-point");
  
  circles.forEach(c => {
    c.addEventListener("mouseenter", (e) => {
      const sIdx = e.target.dataset.seriesIdx;
      const ptIdx = e.target.dataset.allIdx;
      const pt = allSeriesData[sIdx].pts[ptIdx % allSeriesData[sIdx].pts.length];
      
      tooltip.style.opacity = "1";
      tooltip.style.left = `${pt.x}px`;
      tooltip.style.top = `${pt.y}px`;
      tooltip.style.borderColor = pt.color;
      tooltip.innerHTML = `
        <div style="font-size: 0.75rem; font-weight: 700; color: ${pt.color};">${escapeHtml(pt.playerName)}</div>
        <strong>${escapeHtml(pt.label)}</strong><br/>${pt.detail}
      `;
      e.target.setAttribute("r", "6");
      e.target.setAttribute("fill", pt.color);
    });
    c.addEventListener("mouseleave", (e) => {
      tooltip.style.opacity = "0";
      e.target.setAttribute("r", "4");
      e.target.setAttribute("fill", "var(--app-bg-solid)");
    });
  });
};

// ----------------- MODAL RENDERERS ----------------- //

export const renderPlayerListModal = (standings, history) => {
  const modal = document.getElementById("playerListModal");
  if (!modal) return;

  // Flatten unique players from standings
  const playerMap = new Map();
  standings.forEach(s => {
    if (!s.name) return;
    const name = s.name.trim();
    if (!playerMap.has(name)) {
      playerMap.set(name, s);
    }
  });

  const players = Array.from(playerMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  const renderList = (filter = "") => {
    const listEl = modal.querySelector("#vizPlayerList");
    if (!listEl) return;

    const query = filter.toLowerCase().trim();
    const filtered = players.filter(p => p.name.toLowerCase().includes(query));

    listEl.innerHTML = filtered.map(p => {
      const matchCount = p.matchCount || 0;
      return `
        <div class="viz-player-item" data-name="${escapeHtml(p.name)}">
          <div>
            <span class="viz-player-name-main">${escapeHtml(p.name)}</span>
          </div>
          <div class="viz-player-meta-small">${matchCount} Matches</div>
        </div>
      `;
    }).join('');

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="empty-state">No players found matching "${escapeHtml(filter)}"</div>`;
    }
  };

  const html = `
    <div class="dashboard-container">
      <header class="viz-header">
        <h2>👤 Select Player</h2>
        <button class="close-btn"><i class="fa-solid fa-xmark"></i></button>
      </header>
      
      <div class="viz-search-container">
        <i class="fa-solid fa-magnifying-glass viz-search-icon"></i>
        <input type="text" id="vizPlayerSearch" class="viz-search-input" placeholder="Search by name..." autocomplete="off">
      </div>

      <div id="vizPlayerList" class="viz-player-list">
        <!-- List injected here -->
      </div>
    </div>
  `;
  
  modal.innerHTML = html;
  setupModalClose(modal);
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  renderList();

  const searchInput = modal.querySelector("#vizPlayerSearch");
  searchInput?.addEventListener("input", (e) => renderList(e.target.value));

  modal.querySelector("#vizPlayerList")?.addEventListener("click", (e) => {
    const item = e.target.closest(".viz-player-item");
    if (item) {
      const name = item.dataset.name;
      modal.classList.add("hidden");
      renderPlayerProfile(name, history, standings);
    }
  });
};

export const renderPlayerProfile = (playerName, history, standings) => {
  console.log("renderPlayerProfile entered for:", playerName);
  try {
    _history = history || {};
    _standings = standings || [];
    const modal = document.getElementById("playerProfileModal");
    if (!modal) return;
    
    const stats = computePlayerStats(playerName, history);
    
    let bestMatchHtml = `[None]`;
    if (stats.bestMatchId) {
      bestMatchHtml = `<span class="viz-stat-val clickable" title="View Match" data-mid="${stats.bestMatchId}">${stats.bestMatchTotal} Pts</span>`;
    } else {
      bestMatchHtml = `<span class="viz-stat-val">-</span>`;
    }
    
      // Scaling base: Best match total of the player (or 420 as safety max if best is low)
      const MAX_VAL = Math.max(stats.bestMatchTotal, 1);
      
      // Build Bars
      let barsHtml = '';
      const reversedSeries = [...stats.matchSeries].reverse();
      
      reversedSeries.forEach(m => {
        if (!m.played) {
          barsHtml += `
            <div class="viz-bar-row">
              <div class="viz-bar-label viz-match-link" data-mid="${m.matchId}">${escapeHtml(m.matchTitle)}</div>
              <div class="viz-bar-track"><span class="viz-stat-label" style="opacity: 0.3;">MISSED</span></div>
              <div class="viz-bar-score">0 <span class="viz-match-medal-spacer"></span></div>
            </div>
          `;
          return;
        }
        
        // Combined bar width relative to Max Match
        const matchTotal = m.p1Score + m.p2Score;
        const barWidthPct = (matchTotal / MAX_VAL) * 100;
        
        // Logic check: if combined is 0 (all penalty?), handle with minimal width or skip
        const safeTotal = Math.max(matchTotal, 1);
        const p1InternalPct = (m.p1Score / safeTotal) * 100;
        const p2InternalPct = (m.p2Score / safeTotal) * 100;
        
        const penPct = Math.min(100, (20 / safeTotal) * 100); 
        
        let penaltyOverlay = '';
        let penaltyBadge = '';
        if (m.penalty < 0) {
          penaltyBadge = `<span class="viz-badge-pen">-20</span>`;
          // Positioned relative to the FILL WRAPPER
          penaltyOverlay = `<div class="viz-bar-penalty-overlay" style="left: calc(${100 - penPct}%); width: ${penPct}%;"></div>`;
        }

        let medalHtml = '';
        if (m.medal === 'gold') medalHtml = ' <span class="viz-match-medal">🥇</span>';
        else if (m.medal === 'silver') medalHtml = ' <span class="viz-match-medal">🥈</span>';
        else if (m.medal === 'bronze') medalHtml = ' <span class="viz-match-medal">🥉</span>';
        else medalHtml = ' <span class="viz-match-medal-spacer"></span>';

        barsHtml += `
          <div class="viz-bar-row">
            <div class="viz-bar-label viz-match-link" data-mid="${m.matchId}">${escapeHtml(m.matchTitle)}</div>
            <div class="viz-bar-track">
              <div class="viz-bar-fill-wrapper" style="width: ${barWidthPct}%;">
                <div class="viz-bar-p1" style="width: ${p1InternalPct}%;"></div>
                <div class="viz-bar-p2" style="width: ${p2InternalPct}%;"></div>
                ${penaltyOverlay}
              </div>
            </div>
            <div class="viz-bar-score">${penaltyBadge} ${m.total}${medalHtml}</div>
          </div>
        `;
      });

    const html = `
      <div class="dashboard-container">
        <header class="viz-header">
          <div style="display: flex; align-items: center; gap: 15px;">
            <h2>👤 ${escapeHtml(stats.name)} Stats</h2>
            <div style="font-size: 1.2rem;">🥇${stats.gold} 🥈${stats.silver} 🥉${stats.bronze}</div>
          </div>
          <button class="close-btn"><i class="fa-solid fa-xmark"></i></button>
        </header>
        
        <div class="viz-scroll-wrapper">
          <div class="viz-hero-grid">
            <div class="viz-stat-card"><span class="viz-stat-val">${stats.totalPoints.toLocaleString()}</span><span class="viz-stat-label">Total Pts</span></div>
            <div class="viz-stat-card"><span class="viz-stat-val">${stats.ppg}</span><span class="viz-stat-label">PPG</span></div>
            <div class="viz-stat-card"><span class="viz-stat-val">${stats.gamesParticipated}</span><span class="viz-stat-label">Games</span></div>
            <div class="viz-stat-card">${bestMatchHtml}<span class="viz-stat-label">Best Match</span></div>
            <div class="viz-stat-card"><span class="viz-stat-val">${stats.p1Avg}</span><span class="viz-stat-label">1st Avg</span></div>
            <div class="viz-stat-card"><span class="viz-stat-val">${stats.p2AvgAll}</span><span class="viz-stat-label">2nd Avg (All)</span></div>
            <div class="viz-stat-card"><span class="viz-stat-val">${stats.p2AvgCorrect}</span><span class="viz-stat-label">2nd Avg (Correct)</span></div>
            <div class="viz-stat-card"><span class="viz-stat-val">${stats.exactPredictions}</span><span class="viz-stat-label">Exact Preds</span></div>
            <div class="viz-stat-card"><span class="viz-stat-val">${stats.winPercent}%</span><span class="viz-stat-label">Win Accuracy</span></div>
            <div class="viz-stat-card"><span class="viz-stat-val">${stats.penalties}</span><span class="viz-stat-label">Penalties</span></div>
          </div>
          
          <div class="viz-section">
            <h3>Match Breakdowns</h3>
            <div class="viz-bar-list">
              ${barsHtml || '<div class="empty-state">No match data.</div>'}
            </div>
          </div>
        </div>
        
        <div class="viz-actions">
          <button id="btnOpenTrend" class="glass-pill-btn"><i class="fa-solid fa-chart-line"></i> View Trends</button>
          <button id="btnOpenCompare" class="glass-pill-btn"><i class="fa-solid fa-scale-balanced"></i> Compare Players</button>
        </div>
      </div>
    `;
    
    modal.innerHTML = html;
    setupModalClose(modal);
    modal.classList.remove("hidden");
    console.log("Modal found?", !!modal, "Classes:", modal.className);
    document.body.style.overflow = "hidden";
    
    // Wiring Breakdown Match Links
    modal.querySelectorAll(".viz-match-link").forEach(link => {
      link.addEventListener("click", (e) => {
        const mid = e.currentTarget.dataset.mid;
        if (mid) {
          closeAllVizModals();
          window.dispatchEvent(new CustomEvent("viewMatchDetails", { 
            detail: { matchId: mid, returnTo: playerName } 
          }));
        }
      });
    });

    // Wiring Best Match
    const bestMatchBtn = modal.querySelector(".viz-stat-val.clickable");
    bestMatchBtn?.addEventListener("click", (e) => {
      const mid = e.target.dataset.mid;
      if (mid) {
        closeAllVizModals();
        window.dispatchEvent(new CustomEvent("viewMatchDetails", { 
          detail: { matchId: mid, returnTo: playerName } 
        }));
      }
    });

    // Buttons
    modal.querySelector("#btnOpenTrend")?.addEventListener("click", () => {
      closeAllVizModals();
      renderTrendModal(playerName, _history);
    });
    
    modal.querySelector("#btnOpenCompare")?.addEventListener("click", () => {
      closeAllVizModals();
      renderCompareModal([playerName], _history, _standings);
    });
  } catch(err) {
    console.error("Error in renderPlayerProfile:", err);
  }
};

export const renderTrendModal = (playerName, history) => {
  const modal = document.getElementById("playerTrendModal");
  if (!modal) return;
  const stats = computePlayerStats(playerName, history);

  const html = `
    <div class="dashboard-container">
      <header class="viz-header">
        <h2>📈 Season Trends for ${escapeHtml(playerName)}</h2>
        <button class="close-btn"><i class="fa-solid fa-xmark"></i></button>
      </header>
      
      <div class="viz-section" style="flex-grow: 1;">
        <h3>
          Trajectory
          <div class="viz-chart-tabs">
            <button class="viz-chart-tab" data-mode="cumulative">Cumulative</button>
            <button class="viz-chart-tab active" data-mode="permatch">Per-Match</button>
          </div>
        </h3>
        <div id="trendChartBox" class="viz-svg-container">
          <div class="viz-axis-label-y">Points</div>
          <div class="viz-axis-label-x">Matches</div>
        </div>
      </div>
      
      <button class="glass-pill-btn" id="btnTrendBackToProfile" style="align-self: flex-start;"><i class="fa-solid fa-arrow-left"></i> Back to Profile</button>
    </div>
  `;
  
  modal.innerHTML = html;
  setupModalClose(modal);
  modal.classList.remove("hidden");
  
  const ctx = modal.querySelector("#trendChartBox");
  // Default to per-match per user request
  const series = [{ playerName: playerName, matchData: stats.matchSeries }];
  renderSvgLineGraph(ctx, series, "permatch");
  
  // Toggles
  const tabs = modal.querySelectorAll(".viz-chart-tab");
  tabs.forEach(t => t.addEventListener("click", (e) => {
    tabs.forEach(btn => btn.classList.remove("active"));
    t.classList.add("active");
    renderSvgLineGraph(ctx, series, t.dataset.mode);
  }));

  modal.querySelector("#btnTrendBackToProfile")?.addEventListener("click", () => {
    closeAllVizModals();
    renderPlayerProfile(playerName, history, _standings);
  });
};

export const renderCompareTrendsModal = (playerNames, history) => {
  const modal = document.getElementById("playerTrendModal");
  if (!modal) return;
  
  const hiddenIndices = new Set();
  const seriesArray = playerNames.map((name, i) => {
    const stats = computePlayerStats(name, history);
    return {
      playerName: name.trim(),
      matchData: stats.matchSeries,
      color: VIZ_COLORS[i % VIZ_COLORS.length],
      idx: i
    };
  });

  const updateView = () => {
    const ctx = modal.querySelector("#trendChartBox");
    const activeTab = modal.querySelector(".viz-chart-tab.active");
    const mode = activeTab?.dataset.mode || "permatch";
    
    renderSvgLineGraph(ctx, seriesArray, mode, hiddenIndices);
    
    // Update Legend Visuals
    modal.querySelectorAll(".legend-item").forEach(item => {
      const idx = parseInt(item.dataset.idx);
      if (hiddenIndices.has(idx)) {
        item.classList.add("viz-legend-off");
      } else {
        item.classList.remove("viz-legend-off");
      }
    });
  };

  const legendHtml = seriesArray.map((s, i) => `
    <div class="legend-item" data-idx="${i}" data-player="${escapeHtml(s.playerName)}">
      <div class="legend-dot" style="background: ${s.color}; color: ${s.color};"></div>
      <span>${escapeHtml(s.playerName)}</span>
    </div>
  `).join('');

  const html = `
    <div class="dashboard-container">
      <header class="viz-header">
        <h2>📈 Comparison Trajectory</h2>
        <button class="close-btn"><i class="fa-solid fa-xmark"></i></button>
      </header>
      
      <div class="viz-section" style="flex-grow: 1;">
        <h3>
          Standings Over Time
          <div class="viz-chart-tabs">
            <button class="viz-chart-tab" data-mode="cumulative">Cumulative</button>
            <button class="viz-chart-tab active" data-mode="permatch">Per-Match</button>
          </div>
        </h3>
        <div id="trendChartBox" class="viz-svg-container">
          <div class="viz-axis-label-y">Points</div>
          <div class="viz-axis-label-x">Matches</div>
        </div>
        <div class="viz-chart-legend">
          ${legendHtml}
        </div>
      </div>
      
      <button class="glass-pill-btn" id="btnTrendBackToCompare" style="align-self: flex-start;"><i class="fa-solid fa-arrow-left"></i> Back to Compare</button>
    </div>
  `;
  
  modal.innerHTML = html;
  setupModalClose(modal);
  modal.classList.remove("hidden");
  
  // Initial draw
  updateView();
  
  const chartBox = modal.querySelector("#trendChartBox");

  // Legend Listeners
  modal.querySelectorAll(".legend-item").forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idxStr = item.getAttribute("data-idx");
      const idx = parseInt(idxStr);
      if (isNaN(idx)) return;
      
      if (hiddenIndices.has(idx)) {
        hiddenIndices.delete(idx);
      } else {
        hiddenIndices.add(idx);
      }
      updateView();
    });

    item.addEventListener("mouseenter", () => {
      const playerName = item.dataset.player;
      const group = chartBox.querySelector(`.viz-series-group[data-player="${playerName}"]`);
      if (group) {
        chartBox.classList.add("legend-hovering");
        group.classList.add("legend-highlight");
      }
    });

    item.addEventListener("mouseleave", () => {
      chartBox.classList.remove("legend-hovering");
      const highlighted = chartBox.querySelectorAll(".legend-highlight");
      highlighted.forEach(h => h.classList.remove("legend-highlight"));
    });
  });

  const tabs = modal.querySelectorAll(".viz-chart-tab");
  tabs.forEach(t => t.addEventListener("click", (e) => {
    tabs.forEach(btn => btn.classList.remove("active"));
    t.classList.add("active");
    updateView();
  }));

  modal.querySelector("#btnTrendBackToCompare")?.addEventListener("click", () => {
    closeAllVizModals();
    renderCompareModal(playerNames, history, _standings);
  });
};

export const renderCompareModal = (playerNames, history, standings) => {
  const modal = document.getElementById("compareModal");
  if (!modal) return;
  
  // Always ensure at least 1, max 4.
  const allNamesList = (standings || []).map(s => s.name);
  
  const buildOptions = (selected) => {
    return `<option value="">-- Add --</option>` + allNamesList.map(n => 
      `<option value="${escapeHtml(n)}" ${n===selected?'selected':''}>${escapeHtml(n)}</option>`
    ).join('');
  };

  const cStats = playerNames.map(n => computePlayerStats(n, history));
  
  let theadHtml = `<th>Stat</th>`;
  for(let i=0; i<4; i++) {
    const selName = playerNames[i] || "";
    theadHtml += `
      <th>
        <select class="viz-compare-select" data-col="${i}">
          ${buildOptions(selName)}
        </select>
      </th>
    `;
  }
  
  const getRowHtml = (label, statKey, isHigherBetter = true) => {
    // Find the best player
    let bestVal = isHigherBetter ? -Infinity : Infinity;
    cStats.forEach(s => {
      const v = Number(s[statKey]);
      if (!isNaN(v)) {
        if (isHigherBetter && v > bestVal) bestVal = v;
        if (!isHigherBetter && v < bestVal) bestVal = v;
      }
    });

    let tr = `<tr><td class="stat-label">${label}</td>`;
    for(let i=0; i<4; i++) {
      if (i < cStats.length) {
        const val = cStats[i][statKey];
        const isBest = (Number(val) === bestVal) && (cStats.length > 1);
        tr += `<td class="${isBest ? 'viz-highlight-best' : ''}">
          ${val}${isBest ? ' <span class="viz-highlight-medal">🥇</span>' : ''}
        </td>`;
      } else {
        tr += `<td>-</td>`;
      }
    }
    tr += `</tr>`;
    return tr;
  };

  const html = `
    <div class="dashboard-container">
      <header class="viz-header">
        <h2>⚖️ Compare Players</h2>
        <button class="close-btn"><i class="fa-solid fa-xmark"></i></button>
      </header>
      
      <div class="viz-section">
        <div class="viz-compare-table-wrapper">
          <table class="viz-compare-table">
            <thead><tr>${theadHtml}</tr></thead>
            <tbody>
              ${getRowHtml("Total Points", "totalPoints", true)}
              ${getRowHtml("Games Played", "gamesParticipated", true)}
              ${getRowHtml("PPG", "ppg", true)}
              ${getRowHtml("1st Inn Avg", "p1Avg", true)}
              ${getRowHtml("2nd Inn Avg (Correct)", "p2AvgCorrect", true)}
              ${getRowHtml("Win Acc %", "winPercent", true)}
              ${getRowHtml("Exact Picks", "exactPredictions", true)}
              ${getRowHtml("Double Wins", "bothInningsCorrectCount", true)}
              ${getRowHtml("Gold Medals", "gold", true)}
              ${getRowHtml("Penalties", "penalties", false)}
            </tbody>
          </table>
        </div>
      </div>
      
      <div class="viz-actions" style="margin-top: 20px;">
        <button id="btnCompareTrends" class="glass-pill-btn"><i class="fa-solid fa-chart-line"></i> View Trends Comparison</button>
        <button class="glass-pill-btn" id="btnCompareBackToProfile"><i class="fa-solid fa-arrow-left"></i> Back to Profile</button>
      </div>
    </div>
  `;
  
  modal.innerHTML = html;
  setupModalClose(modal);
  modal.classList.remove("hidden");
  
  // Re-render when dropdown changes
  modal.querySelectorAll(".viz-compare-select").forEach(sel => {
    sel.addEventListener("change", (e) => {
      const col = parseInt(e.target.dataset.col);
      const val = e.target.value;
      const newNames = [...playerNames];
      if (val) newNames[col] = val;
      else {
        newNames[col] = "";
      }
      
      // Clean up empty gaps
      const cleanNames = newNames.filter(Boolean);
      renderCompareModal(cleanNames, history, _standings);
    });
  });

  modal.querySelector("#btnCompareTrends")?.addEventListener("click", () => {
    closeAllVizModals();
    renderCompareTrendsModal(playerNames, history);
  });

  modal.querySelector("#btnCompareBackToProfile")?.addEventListener("click", () => {
    // Only works properly if they came from a profile, defaulting to first person
    if (playerNames.length > 0) {
      closeAllVizModals();
      renderPlayerProfile(playerNames[0], history, _standings);
    } else {
      closeAllVizModals();
    }
  });
};
