export const DEFAULT_ROOM = "ipl-main";
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
  MI: "#004BA0",
  CSK: "#FFFF00",
  RCB: "#EC1C24",
  KKR: "#3A225D",
  SRH: "#FF822A",
  PBKS: "#D71920",
  DC: "#004C99",
  RR: "#EA1A84",
  GT: "#1B2133",
  LSG: "#961212"
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

export const applyTeamTheme = (teamA, teamB) => {
  const getTeamCode = (name) => {
    if (!name) return null;
    const clean = String(name).toUpperCase().trim();
    for (const code in TEAM_COLORS) {
      if (clean === code || clean.startsWith(code + " ") || clean.includes(" " + code)) {
        return code;
      }
    }
    return null;
  };

  const codeA = getTeamCode(teamA);
  const codeB = getTeamCode(teamB);

  const colorA = TEAM_COLORS[codeA] || "#0A84FF";
  const colorB = TEAM_COLORS[codeB] || "#FF453A";

  const textA = getContrastColor(colorA);
  const textB = getContrastColor(colorB);

  const root = document.documentElement;
  root.style.setProperty("--team-a", colorA);
  root.style.setProperty("--team-b", colorB);
  root.style.setProperty("--text-a", textA);
  root.style.setProperty("--text-b", textB);

  // Set a global contrast color based on the "leading" team (usually Home)
  root.style.setProperty("--contrast", textA);

  const grad = `linear-gradient(135deg, ${colorA}ee, ${colorB}ee)`;
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
