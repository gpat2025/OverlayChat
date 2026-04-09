require("dotenv").config();
const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const { calculateInnings1Points, calculateInnings2Points, calculateMatchFinals } = require("./scoring.js");

// --- API CONFIG ---
const API_KEYS = [
  process.env.CRICKET_API_KEY,
  process.env.CRICKET_API_KEY_BACKUP
].filter(Boolean);
let currentKeyIndex = 0;

const getApiKey = () => API_KEYS[currentKeyIndex];
const rotateKey = () => {
  if (currentKeyIndex < API_KEYS.length - 1) {
    currentKeyIndex++;
    console.log(`Rotated to backup API Key (Index: ${currentKeyIndex})`);
    return true;
  }
  return false;
};

// --- FIREBASE HELPER ---
const setupFirebase = () => {
  try {
    const defaultVal = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!defaultVal) throw new Error("No FIREBASE_SERVICE_ACCOUNT");
    const serviceAccount = JSON.parse(defaultVal);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://overlaychat-6f3c1-default-rtdb.asia-southeast1.firebasedatabase.app`
      });
    }
  } catch (err) {
    console.error("Failed to configure Firebase: ", err.message);
    process.exit(1);
  }
};

const getSchedule = () => {
  const filePath = path.join(__dirname, "..", "schedule_2026_ipl.csv");
  const data = fs.readFileSync(filePath, "utf8");
  const lines = data.split("\n").map(l => l.trim()).filter(Boolean);
  return lines.slice(1).map(line => {
    const parts = line.split(",");
    if (parts.length >= 6) {
      return { matchNo: parts[0], date: parts[1], time: parts[2], home: parts[3], away: parts[4], titleStr: parts[5].trim() };
    }
    return null;
  }).filter(Boolean);
};

const fetchApi = async (url) => {
  try {
    const response = await axios.get(`${url}&apikey=${getApiKey()}`);
    if (response.data && response.data.status === "failure") throw new Error(`API returned failure: ${response.data.reason}`);
    return response.data;
  } catch (err) {
    const isRateLimit = err.response?.status === 429 || (err.message && err.message.toLowerCase().includes("limit"));
    if (isRateLimit && rotateKey()) return fetchApi(url);
    throw err;
  }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const runMonitor = async () => {
  console.log("=== STARTING IPL 2026 LIVE MONITOR ===");
  setupFirebase();
  const db = admin.database();
  const ROOM = "ipl";

  // 1. Initial Meta Verification
  let metaSnap = await db.ref(`rooms/${ROOM}/meta`).once("value");
  let meta = metaSnap.val() || {};
  if (meta.automationPaused) {
    console.log("Cloud automation is globally paused by Admin. Exiting cleanly.");
    process.exit(0);
  }

  // 2. Discover Today's Schedule
  const schedule = getSchedule();
  // We use current system time or environment variable for testing
  const now = process.env.TEST_DATE ? new Date(process.env.TEST_DATE) : new Date();

  // GH Actions UTC runs might bleed into the next day logic, we should offset to IST (+5:30)
  // Let's create an IST Date object
  const istOffset = 5.5 * 60 * 60 * 1000;
  let istTime = new Date(now.getTime() + istOffset);
  // Subtract system timezone offset to get true IST representation independent of system local
  istTime = new Date(istTime.getTime() + (new Date().getTimezoneOffset() * 60 * 1000));

  const dd = String(istTime.getDate()).padStart(2, '0');
  const mm = String(istTime.getMonth() + 1).padStart(2, '0');
  const yyyy = istTime.getFullYear();
  const todayStr = `${dd}-${mm}-${yyyy}`;

  let todaysMatches = schedule.filter(m => m.date === todayStr);

  if (todaysMatches.length === 0) {
    console.log(`No match scheduled for ${todayStr}. Exiting.`);
    process.exit(0);
  }

  // Check if we are closer to the 1st match (3:30 PM) or 2nd match (7:30 PM)
  // If only 1 match, it's at index 0. If double header, decide based on time.
  const hours = istTime.getHours();
  // 7:30 PM = 19
  // 3:30 PM = 15
  let matchIdx = 0;
  if (todaysMatches.length > 1 && hours >= 16) {
    matchIdx = 1; // Picking the evening match
  }

  const targetMatch = todaysMatches[matchIdx];
  console.log(`Target Match: #${targetMatch.matchNo} - ${targetMatch.home} vs ${targetMatch.away} (${targetMatch.time})`);

  // 2. Initial Resolution Check
  const stateCheck = await db.ref(`rooms/${ROOM}/monitor_state`).once('value');
  if (stateCheck.val() && stateCheck.val().matchNo === targetMatch.matchNo && stateCheck.val().finished) {
    console.log(`Match #${targetMatch.matchNo} was already fully resolved. Exiting.`);
    process.exit(0);
  }

  // --- Double Header Sequence Protection ---
  if (matchIdx > 0) {
    const prevMatch = todaysMatches[matchIdx - 1];
    let isPrevResolved = false;
    while (!isPrevResolved) {
      const prevSnap = await db.ref(`rooms/${ROOM}/monitor_state`).once('value');
      const prevState = prevSnap.val() || {};
      
      if (prevState.matchNo === targetMatch.matchNo) {
        isPrevResolved = true; // Already moved on to this match
      } else if (prevState.matchNo === prevMatch.matchNo && prevState.finished) {
        console.log(`Previous match #${prevMatch.matchNo} is fully resolved. Safe to start Match #${targetMatch.matchNo}.`);
        isPrevResolved = true;
      } else if (prevState.matchNo && prevState.matchNo !== prevMatch.matchNo) {
        isPrevResolved = true; // Handling an unrelated match
      } else if (!prevState.matchNo) {
        isPrevResolved = true; // Empty state
      } else {
        console.log(`Match #${prevMatch.matchNo} is still IN PROGRESS. Waiting 5 mins to avoid data overwrite...`);
        await sleep(5 * 60 * 1000);
      }
    }
  }

  // Wait to find exactly this match ID from API
  let matchId = process.env.TEST_MATCH_ID || null;
  while (!matchId) {
    try {
      console.log("Fetching /currentMatches to find target match...");
      const res = await fetchApi("https://api.cricapi.com/v1/currentMatches?offset=0");
        const TEAM_MAP = {
          "CSK": "chennai",
          "DC": "delhi",
          "GT": "gujarat",
          "KKR": "kolkata",
          "LSG": "lucknow",
          "MI": "mumbai",
          "PBKS": "punjab",
          "RR": "rajasthan",
          "RCB": "royal challengers",
          "SRH": "sunrisers"
        };
        const homeKey = TEAM_MAP[targetMatch.home] || targetMatch.home.toLowerCase();
        const awayKey = TEAM_MAP[targetMatch.away] || targetMatch.away.toLowerCase();

        const found = res.data.find(m => m.name.toLowerCase().includes(homeKey) && m.name.toLowerCase().includes(awayKey));
        if (found) matchId = found.id;
    } catch (err) {
      console.error("Error finding match:", err.message);
    }
    if (!matchId) {
      console.log("Match not found yet. Retrying in 5 mins.");
      await sleep(5 * 60 * 1000);
    }
  }

  console.log(`FOUND Match DB ID: ${matchId}`);

  // PRE-TOSS PHASE
  let isTossConfirmed = false;
  let battingTeamFull = "";
  let battingTeamAbbr = "";
  let isFirstInningsLocked = false;
  let isSecondInningsLocked = false;
  let liveTeamInfo = [];
  let firstInningsResolved = false;

  console.log("--- ENTERING MONITOR LOOP ---");

  let hasSleptInnings1 = false;
  let hasSleptInnings2 = false;

  while (true) {
    // Re-check manual override
    metaSnap = await db.ref(`rooms/${ROOM}/meta`).once("value");
    meta = metaSnap.val() || {};
    if (meta.automationPaused) {
      console.log("Automation paused by admin mid-run. Exiting.");
      process.exit(0);
    }

    try {
      let info;
      if (!isTossConfirmed) {
        info = await fetchApi(`https://api.cricapi.com/v1/match_info?id=${matchId}`);
      } else {
        // Use currentMatches as a lightweight score source
        const list = await fetchApi(`https://api.cricapi.com/v1/currentMatches?offset=0`);
        const found = list.data && list.data.find(m => m.id === matchId);
        if (!found) {
           console.log("Match not found in currentMatches list. Falling back to match_info...");
           info = await fetchApi(`https://api.cricapi.com/v1/match_info?id=${matchId}`);
        } else {
           // Standardize structure to match what we expect from match_info
           info = { data: found };
        }
      }

      if (!info || !info.data) throw new Error("No data inside API response");

      const { tossWinner, tossChoice, matchWinner, score, status } = info.data;
      // We only update teamInfo from the detailed API or if the list provides it
      if (info.data.teamInfo) liveTeamInfo = info.data.teamInfo;

      console.log(`[API Call] Status: ${status}`);

      // Handle Rainout / Abandoned BEFORE toss or 1st innings
      if (status.toLowerCase().includes("no result") || status.toLowerCase().includes("abandoned") || matchWinner === "No Winner") {
        console.log(`Match Rained Out/Abandoned! Status: ${status}`);
        if (!firstInningsResolved) {
          console.log("Scrapping the entire game data. Room cleared.");
        } else {
          console.log("Scrapping 2nd Innings. Resolving match with only 1st innings data.");
          const histSnap = await db.ref(`rooms/${ROOM}/innings_history/1st`).once("value");
          const totals = calculateMatchFinals(histSnap.val() || {}, {});
          await db.ref(`rooms/${ROOM}/history/${todayStr}_${targetMatch.home}v${targetMatch.away}`).set({ matchTitle: targetMatch.titleStr, finalStandings: totals, rainedOut2nd: true });
        }
        await db.ref(`rooms/${ROOM}/monitor_state`).set({ matchNo: targetMatch.matchNo, finished: true });
        process.exit(0);
      }

      // 1. TOSS EXTRACTION
      if (!isTossConfirmed && tossWinner && tossChoice) {
        if (tossChoice.toLowerCase() === "bat") battingTeamFull = tossWinner;
        else {
          const other = liveTeamInfo.find(t => t.name.toLowerCase() !== tossWinner.toLowerCase());
          battingTeamFull = other?.name || "";
        }
        const bObj = liveTeamInfo.find(t => t.name.toLowerCase() === battingTeamFull.toLowerCase());
        battingTeamAbbr = bObj ? bObj.shortname : "";

        console.log(`Toss complete. Batting: ${battingTeamFull} (${battingTeamAbbr})`);

        let disableScoreA = false;
        let disableScoreB = false;
        if (battingTeamAbbr.toLowerCase() === targetMatch.home.toLowerCase()) disableScoreB = true;
        if (battingTeamAbbr.toLowerCase() === targetMatch.away.toLowerCase()) disableScoreA = true;

        // Clear live match containers when a new match begins
        await db.ref(`rooms/${ROOM}/innings_history`).remove();
        await db.ref(`rooms/${ROOM}/predictions`).remove();

        await db.ref(`rooms/${ROOM}/meta`).update({
          matchTitle: targetMatch.titleStr,
          teamA: targetMatch.home,
          teamB: targetMatch.away,
          disableScoreA,
          disableScoreB,
          secondInnings: false,
          predictionsPaused: false
        });
        isTossConfirmed = true;
      }

      if (isTossConfirmed && score && score.length > 0) {
        // Evaluate active innings state
        const s1 = score[0];
        const s2 = score[1];
        
        const activeS = s2 || s1;
        console.log(`[Live Score] ${activeS.inning}: ${activeS.r}/${activeS.w} (${activeS.o} Overs)`);

        // fallback: If the API status says "Innings Break", it's time to resolve even if overs < 20
        const isInningsBreak = status.toLowerCase().includes("innings break");

        // 2. FIRST INNINGS PROGRESS
        if (!firstInningsResolved) {
          if (!isFirstInningsLocked && s1.o >= 3.0) {
            console.log("3.0 Overs reached in 1st Innings! Locking predictions.");
            await db.ref(`rooms/${ROOM}/meta/predictionsPaused`).set(true);
            isFirstInningsLocked = true;
          }

          // Innings 1 Ends when 20 overs are reached, 10 wickets fall, OR the API explicitly spawns the 2nd innings OR Innings Break status
          if (s1.o >= 20.0 || s1.w >= 10 || s2 || isInningsBreak) {
            console.log("1st Innings complete (or break detected). Resolving scores...");
            const predSnap = await db.ref(`rooms/${ROOM}/predictions`).once("value");
            const preds = predSnap.val() || {};

            for (let pid in preds) {
              const stats = calculateInnings1Points(preds[pid], s1.r, meta);
              preds[pid] = { ...preds[pid], ...stats, points: stats.points };
            }
            await db.ref(`rooms/${ROOM}/innings_history/1st`).set(preds);
            await db.ref(`rooms/${ROOM}/predictions`).remove();

            // Flip room meta for 2nd innings
            const disableScoreA = !meta.disableScoreA;
            const disableScoreB = !meta.disableScoreB;
            await db.ref(`rooms/${ROOM}/meta`).update({ secondInnings: true, predictionsPaused: false, disableScoreA, disableScoreB });
            firstInningsResolved = true;
            console.log("Room transitioned to 2nd Innings.");
          }
        }
        // 3. SECOND INNINGS PROGRESS
        else if (s2) {
          if (!isSecondInningsLocked && s2.o >= 3.0) {
            console.log("3.0 Overs reached in 2nd Innings! Locking predictions.");
            await db.ref(`rooms/${ROOM}/meta/predictionsPaused`).set(true);
            isSecondInningsLocked = true;
          }

          // Match ends on 2nd innings constraints
          if (s2.o >= 20.0 || s2.w >= 10 || (matchWinner && matchWinner !== "No Winner")) {
            console.log(`2nd Innings complete. Winner: ${matchWinner}`);
            const isChaserWinner = matchWinner.toLowerCase() !== s1.inning.toLowerCase().replace(' inning 1', '');

            const predSnap = await db.ref(`rooms/${ROOM}/predictions`).once("value");
            const preds = predSnap.val() || {};

            // Note: If chaser won, their target metric is the Overs format (s2.o). If defender won, target metric is Score format (s2.r)
            const actualResult = isChaserWinner ? s2.o : s2.r;
            // Get abbreviations
            const winnerObj = liveTeamInfo.find(t => t.name.toLowerCase() === matchWinner.toLowerCase());
            const winAbbr = winnerObj ? winnerObj.shortname : "---";

            for (let pid in preds) {
              const stats = calculateInnings2Points(preds[pid], winAbbr.toLowerCase(), actualResult, meta, isChaserWinner);
              preds[pid] = { ...preds[pid], ...stats, points: stats.points };
            }

            await db.ref(`rooms/${ROOM}/innings_history/2nd`).set(preds);
            await db.ref(`rooms/${ROOM}/predictions`).remove();

            // Total Up game
            const h1Snap = await db.ref(`rooms/${ROOM}/innings_history/1st`).once("value");
            const totals = calculateMatchFinals(h1Snap.val() || {}, preds);

            await db.ref(`rooms/${ROOM}/history/${todayStr}_${targetMatch.home}v${targetMatch.away}`).set({ matchTitle: targetMatch.titleStr, finalStandings: totals });

            // Mark Match as full complete
            await db.ref(`rooms/${ROOM}/monitor_state`).set({ matchNo: targetMatch.matchNo, finished: true });

            console.log("Fully Resolved and Archived Match. Exiting process.");
            process.exit(0);
          }
        }
      }

      // --- DYNAMIC POLLING SPEED CALCULATION ---
      let delay = 5 * 60 * 1000; // Default: 5 mins

      if (!isTossConfirmed) {
        delay = 3 * 60 * 1000; // Pre-toss: 3 mins
      } else {
        const s1 = (info.data.score && info.data.score[0]) || null;
        const s2 = (info.data.score && info.data.score[1]) || null;

        if (!firstInningsResolved && s1) {
          if (s1.o >= 3.0 && !hasSleptInnings1) {
            console.log("3.0 Overs reached (Innings 1). Entering 60-minute optimization sleep.");
            delay = 60 * 60 * 1000;
            hasSleptInnings1 = true;
          } else if (s1.o >= 19.0) {
            console.log("19.0 Overs reached (Innings 1). Increasing polling frequency to 2 mins.");
            delay = 2 * 60 * 1000;
          }
        } else if (firstInningsResolved && s2) {
          if (s2.o >= 3.0 && !hasSleptInnings2) {
            console.log("3.0 Overs reached (Innings 2). Entering 60-minute optimization sleep.");
            delay = 60 * 60 * 1000;
            hasSleptInnings2 = true;
          } else if (s2.o >= 19.0) {
            console.log("19.0 Overs reached (Innings 2). Increasing polling frequency to 2 mins.");
            delay = 2 * 60 * 1000;
          }
        }
      }

      await sleep(delay);

    } catch (err) {
      console.error("Monitor Loop API Error: ", err.message);
      await sleep(5 * 60 * 1000); // Standard retry delay on error
    }
  }
};

runMonitor();
