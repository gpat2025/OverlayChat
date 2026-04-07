export const DEFAULT_ROOM = "ipl";
export const HOSTED_AUDIENCE_ORIGIN = "https://vrccim.com";

export const getRoomId = () => {
  const params = new URLSearchParams(window.location.search);
  const requestedRoom = params.get("roomId") || params.get("room") || params.get("r") || DEFAULT_ROOM;
  return requestedRoom.toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 40) || DEFAULT_ROOM;
};

export const hasExplicitRoomCode = () => {
  const params = new URLSearchParams(window.location.search);
  return Boolean(params.get("room") || params.get("r"));
};

export const getAudienceEntryUrl = () => {
  if (window.location.protocol === "file:") {
    return `${HOSTED_AUDIENCE_ORIGIN}/`;
  }

  const url = new URL("/", window.location.href);
  url.search = "";
  return url.toString();
};

export const getClientId = () => {
  const key = "overlaychat-client-id";
  const existing = localStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const next = `viewer-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(key, next);
  return next;
};

export const rememberViewerName = (name) => {
  localStorage.setItem("overlaychat-viewer-name", name);
};

export const getRememberedViewerName = () =>
  localStorage.getItem("overlaychat-viewer-name") || "";

export const isHostedShortRouteSupported = () =>
  /(?:web\.app|firebaseapp\.com|vrccim\.com)$/i.test(window.location.host);

export const buildRoomUrl = ({ shortPath, fallbackPath }, roomId) => {
  if (window.location.protocol === "file:") {
    const url = new URL(HOSTED_AUDIENCE_ORIGIN);
    url.pathname = shortPath === "/a" ? "/" : shortPath;
    url.search = "";
    if (roomId && roomId !== DEFAULT_ROOM) {
      url.searchParams.set("r", roomId);
    }
    return url.toString();
  }

  const useShortPath = isHostedShortRouteSupported();
  const url = new URL(useShortPath ? shortPath : fallbackPath, window.location.href);
  const paramName = useShortPath ? "r" : "room";

  url.search = "";
  if (roomId && roomId !== DEFAULT_ROOM) {
    url.searchParams.set(paramName, roomId);
  }

  return url.toString();
};

export const formatWinnerCounts = (predictions) => {
  return predictions.reduce((accumulator, prediction) => {
    const winner = prediction.predictedWinner || "Undecided";
    accumulator[winner] = (accumulator[winner] || 0) + 1;
    return accumulator;
  }, {});
};

export const sortByTimestampDescending = (items, key) => {
  return [...items].sort((left, right) => (right[key] || 0) - (left[key] || 0));
};

export const sortByTimestampAscending = (items, key) => {
  return [...items].sort((left, right) => (left[key] || 0) - (right[key] || 0));
};

export const escapeHtml = (value = "") =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const setHidden = (element, shouldHide) => {
  element.classList.toggle("hidden", shouldHide);
};

export const TEAM_COLORS = {
  MI: { primary: "#004BA0", secondary: "#D1AB3E" }, // Blue & Gold
  CSK: { primary: "#FFFF00", secondary: "#0081E5" }, // Yellow & Blue
  RCB: { primary: "#EC1C24", secondary: "#000000" }, // Red & Black
  KKR: { primary: "#3A225D", secondary: "#B39959" }, // Purple & Gold
  SRH: { primary: "#FF822A", secondary: "#000000" }, // Orange & Black
  PBKS: { primary: "#D71920", secondary: "#D4AF37" }, // Red & Gold
  DC: { primary: "#1E5FBF", secondary: "#EF1B23" }, // Blue & Red (Lightened DC blue slightly for contrast)
  RR: { primary: "#EA1A85", secondary: "#004B8C" }, // Pink & Blue
  GT: { primary: "#0B1350", secondary: "#BC9412" }, // Navy & Gold
  LSG: { primary: "#0057E2", secondary: "#E10715" }  // Cyan & Red
};

export const TEAM_LOGOS = {
  MI: "Mumbai_Indians.svg",
  CSK: "Chennai_Super_Kings.svg",
  RCB: "Royal_Challengers_Bengaluru.svg",
  KKR: "Kolkata_Knight_Riders.svg",
  SRH: "Sunrisers_Hyderabad.svg",
  PBKS: "Punjab_Kings.svg",
  DC: "Delhi_Capitals.svg",
  RR: "Rajasthan_Royals.svg",
  GT: "Gujarat_Titans.svg",
  LSG: "Lucknow_Super_Giants.svg"
};

export const getTeamLogoPath = (name) => {
  if (!name) return null;
  const clean = String(name).toUpperCase().trim();
  for (const code in TEAM_LOGOS) {
    if (clean === code || clean.startsWith(code + " ") || clean.includes(" " + code)) {
      return `./assets/IPL_Logos_SVGs/${TEAM_LOGOS[code]}`;
    }
  }
  return null;
};

const getContrastColor = (hex) => {
  if (!hex || hex.length < 6) return "#ffffff";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#000000" : "#ffffff";
};

const muteColor = (hex, amount = 0.25) => {
  if (!hex || hex.length < 7) return hex;
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  // Blend with neutral dark slate (#1a1a1b) to mute saturation
  r = Math.floor(r * (1 - amount) + 26 * amount);
  g = Math.floor(g * (1 - amount) + 26 * amount);
  b = Math.floor(b * (1 - amount) + 27 * amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
};

const getMidColor = (hex1, hex2) => {
  if (!hex1 || !hex2) return hex1 || hex2;
  const r1 = parseInt(hex1.slice(1, 3), 16);
  const g1 = parseInt(hex1.slice(3, 5), 16);
  const b1 = parseInt(hex1.slice(5, 7), 16);
  const r2 = parseInt(hex2.slice(1, 3), 16);
  const g2 = parseInt(hex2.slice(3, 5), 16);
  const b2 = parseInt(hex2.slice(5, 7), 16);
  const r = Math.floor((r1 + r2) / 2);
  const g = Math.floor((g1 + g2) / 2);
  const b = Math.floor((b1 + b2) / 2);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
};

export const getTeamCode = (name) => {
  if (!name) return null;
  const clean = String(name).toUpperCase().trim();
  for (const code in TEAM_COLORS) {
    if (clean === code || clean.startsWith(code + " ") || clean.includes(" " + code)) {
      return code;
    }
  }
  return null;
};

export const applyTeamTheme = (teamA, teamB) => {
  const codeA = getTeamCode(teamA);
  const codeB = getTeamCode(teamB);

  const colorsA = TEAM_COLORS[codeA] || { primary: "#0A84FF", secondary: "#0A84FF" };
  const colorsB = TEAM_COLORS[codeB] || { primary: "#FF453A", secondary: "#FF453A" };

  const pA = muteColor(colorsA.primary);
  const sA = muteColor(colorsA.secondary);
  const pB = muteColor(colorsB.primary);
  const sB = muteColor(colorsB.secondary);

  const midP = getMidColor(pA, pB);

  const textA = getContrastColor(colorsA.primary);
  const root = document.documentElement;
  root.style.setProperty("--team-a", pA);
  root.style.setProperty("--team-a-alt", sA);
  root.style.setProperty("--team-b", pB);
  root.style.setProperty("--team-b-alt", sB);
  root.style.setProperty("--team-a-text", textA);

  root.style.setProperty("--contrast", textA);

  const grad = `linear-gradient(100deg, ${sA}cc 0%, ${pA}cc 25%, ${midP}cc 50%, ${pB}cc 75%, ${sB}cc 100%)`;
  root.style.setProperty("--team-gradient", grad);
};

/**
 * Converts "18.2" overs notation into total balls (110).
 * Used for precise scoring logic.
 */
export const oversToBalls = (val) => {
  const num = Number(val || 0);
  const overs = Math.floor(num);
  const balls = Math.round((num - overs) * 10);
  return overs * 6 + balls;
};

/**
 * Strips Klipy URLs from the message text to clean up the UI
 * when media (GIFs/Stickers) are also being rendered separately.
 */
export const stripKlipyUrl = (text = "") => {
  if (!text) return "";
  // Handles klipy.co, klipy.com, static.klipy.com, etc.
  return text.replace(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*klipy\.(?:co|com)\/[^\s]+/g, "").trim();
};
/**
 * Standardized sorting for match history collections (Firebase history node).
 * Ensures latest matches (like 2026-04-07) are at the top.
 */
export const sortHistoryLatestFirst = (historyObj = {}) => {
  return Object.entries(historyObj).sort((a, b) => {
    const parseToIso = (idStr) => {
      const datePart = idStr.split("_")[0];
      const parts = datePart.split("-");
      
      if (parts.length === 3) {
        // If it's YYYY-MM-DD
        if (parts[0].length === 4) return datePart;
        // If it's legacy DD-MM-YYYY -> convert to YYYY-MM-DD for sorting
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
      }
      return "0000-00-00";
    };

    const isoA = parseToIso(a[0]);
    const isoB = parseToIso(b[0]);

    if (isoA !== isoB) {
      return isoB.localeCompare(isoA);
    }
    
    // Secondary sort by full suffix (timestamp/Manual) descending
    return b[0].localeCompare(a[0]);
  });
};
