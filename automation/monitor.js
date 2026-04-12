require("dotenv").config();
const https = require('https');
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const { calculateInnings1Points, calculateInnings2Points, calculateMatchFinals } = require("./scoring.js");
const util = require("util");

// --- FORCE REAL-TIME LOG OUTPUT ---
const getTimestamp = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}, ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
};
console.log = (...args) => { process.stdout.write(`[${getTimestamp()}] ` + util.format(...args) + "\n"); };
console.error = (...args) => { process.stderr.write(`[${getTimestamp()}] ` + util.format(...args) + "\n"); };
console.warn = (...args) => { process.stderr.write(`[${getTimestamp()}] ` + util.format(...args) + "\n"); };

// --- HELPERS ---

const fetchUrl = (url) =>
  new Promise((resolve, reject) => {
    // Add cache buster to URL
    const sep = url.includes('?') ? '&' : '?';
    const finalUrl = `${url}${sep}t=${Date.now()}`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/123.0.0.0 Safari/537.36',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    };
    https.get(finalUrl, options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        else resolve(body);
      });
    }).on('error', reject);
  });

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
  if (!fs.existsSync(filePath)) return [];
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

// --- LOGIC HELPERS ---

const IPL_TEAM_MAP = {
  "MI": "Mumbai Indians",
  "CSK": "Chennai Super Kings",
  "RCB": "Royal Challengers Bengaluru",
  "KKR": "Kolkata Knight Riders",
  "SRH": "Sunrisers Hyderabad",
  "PBKS": "Punjab Kings",
  "DC": "Delhi Capitals",
  "RR": "Rajasthan Royals",
  "GT": "Gujarat Titans",
  "LSG": "Lucknow Super Giants"
};

/**
 * Robustly checks if a candidate team string matches a target team string.
 * Handles abbreviations, initials, and full names.
 */
const isTeamMatch = (candidate, target) => {
  if (!candidate || !target) return false;
  const c = candidate.toUpperCase().trim();
  const t = target.toUpperCase().trim();
  
  // 1. Direct or mapping match
  if (c === t || c.includes(t) || t.includes(c)) return true;

  // 2. Check IPL Mapping
  for (const [abbr, full] of Object.entries(IPL_TEAM_MAP)) {
    const upperAbbr = abbr.toUpperCase();
    const upperFull = full.toUpperCase();
    if ((c === upperAbbr && t === upperFull) || (t === upperAbbr && c === upperFull)) return true;
  }
  
  // 3. Initials (e.g., "GT" matches "Gujarat Titans")
  const initialsOfCandidate = c.split(/\s+/).map(w => w[0]).join("");
  const initialsOfTarget = t.split(/\s+/).map(w => w[0]).join("");
  if (initialsOfCandidate === t || initialsOfTarget === c) return true;
  
  // 4. First word match (e.g., "Kolkata" matches "Kolkata Knight Riders")
  const firstWordC = c.split(/\s+/)[0];
  const firstWordT = t.split(/\s+/)[0];
  if (firstWordC === firstWordT && firstWordC.length >= 3) return true;

  return false;
};

// --- SCRAPER LOGIC ---

/**
 * Scrapes Cricbuzz to find a match and its details.
 * Mimics the structure returned by the old CricAPI for compatibility.
 */
const scrapeCricbuzzMatch = async (teamA, teamB, matchPath = null) => {
  try {
    let path = matchPath;

    // 1. If no path, find it from the live scores page
    if (!path) {
      console.log(`[Scraper] Searching for match: ${teamA} vs ${teamB}...`);
      const liveHtml = await fetchUrl('https://www.cricbuzz.com/cricket-match/live-scores');
      const matchRegex = /href="(\/live-cricket-scores\/(\d+)\/([^"]+))"/g;
      const lowerA = teamA.toLowerCase();
      const lowerB = teamB.toLowerCase();
      
      let m;
      while ((m = matchRegex.exec(liveHtml)) !== null) {
        if (m[3].includes(lowerA) || m[3].includes(lowerB)) {
            // Check if BOTH teams are in the slug or description
            const context = liveHtml.slice(m.index - 500, m.index + 500);
            if (context.toLowerCase().includes(lowerA) && context.toLowerCase().includes(lowerB)) {
                path = m[1];
                break;
            }
        }
      }
    }

    if (!path) return { status: 'failure', reason: 'Match not found' };

    // 2. Fetch the match page
    const html = await fetchUrl(`https://www.cricbuzz.com${path}`);
    
    // 3. Extract Meta Info (Title and Description)
    // Use dotAll flag (s) and case-insensitivity to handle newlines and varied casing
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const descMatch = html.match(/<meta\s+name="description"\s+content="([\s\S]*?)"/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const desc = descMatch ? descMatch[1].trim() : '';
    
    // 4. Extract Status
    let status = 'In Progress';
    
    // Specifically strip scripts to avoid matching JSON-LD data as status
    const bodySearch = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');

    const resultPatterns = [
        /class="[^"]*cb-text-complete[^"]*"[^>]*>\s*([^<]+)\s*</i,
        /class="[^"]*cb-text-inprogress[^"]*"[^>]*>\s*([^<]+)\s*</i,
        /class="[^"]*cb-text-live[^"]*"[^>]*>\s*([^<]+)\s*</i,
        /class="[^"]*cb-text-stts[^"]*"[^>]*>\s*([^<]+)\s*</i,
        // Match "opted to bowl/bat" or "opt to bowl/bat" specifically
        />\s*([^<]*(?:opted to|opt to) (?:bat|bowl)[^<]*)\s*</i,
        // Broad fallback last
        />\s*([^<]*(?:won by|Match tied|Match abandoned|No result)[^<]*)\s*</i
    ];
    for (const pat of resultPatterns) {
        const found = bodySearch.match(pat);
        if (found && found[1].trim()) {
            const raw = found[1].trim();
            if (raw.length < 150) { // Safety check to avoid large blobs
                status = raw;
                break;
            }
        }
    }
    
    // 5. Extract Toss
    let tossWinner = null;
    let tossChoice = null;
    // Patterns: "X won the toss and opted to bat", "X opt to bowl", "X opt to bat"
    const tossPatterns = [
        />\s*([^<.]+?)\s+won the toss and\s+(?:opted to|opt to)\s+(bat|bowl)/i,
        />\s*([^<.]+?)\s+(?:opted to|opt to)\s+(bat|bowl)/i,
        /([A-Z]{2,5})\s+won the toss and\s+(?:opted to|opt to)\s+(bat|bowl)/i,
        /([A-Z]{2,5})\s+(?:opted to|opt to)\s+(bat|bowl)/i
    ];
    for (const pat of tossPatterns) {
        const tm = html.match(pat);
        if (tm) {
            const candidate = tm[1].trim();
            if (isTeamMatch(candidate, teamA) || isTeamMatch(candidate, teamB)) {
                tossWinner = candidate;
                tossChoice = tm[2].trim();
                break;
            }
        }
    }

    // 6. Extract Scores
    const scoreList = [];
    
    // Strategy D: JSON State Extraction (Highest Reliability)
    // We look for score/wickets/overs patterns in the JSON state (often escaped as \")
    const teamScorePatterns = [
        /\\?\"teamName\\?\":\\?\"([A-Z]+)\\?\"[\s\S]{1,500}?\\?\"score\\?\":(\d+)[\s\S]{1,100}?\\?\"wickets\\?\":(\d+)[\s\S]{1,100}?\\?\"overs\\?\":([\d.]+)/g,
        /\"teamName\":\"([A-Z]+)\"[\s\S]{1,500}?\"score\":(\d+)[\s\S]{1,100}?\"wickets\":(\d+)[\s\S]{1,100}?\"overs\":([\d.]+)/g
    ];
    for (const pat of teamScorePatterns) {
        let jm;
        while ((jm = pat.exec(html)) !== null) {
            scoreList.push({
                inning: jm[1].toUpperCase(),
                r: parseInt(jm[2]),
                w: parseInt(jm[3]),
                o: parseFloat(jm[4])
            });
        }
    }
    if (scoreList.length > 0) console.log(`[Scraper] Strategy D (JSON) found ${scoreList.length} scores.`);

    // Strategy A: Mini-scorecard divs (Clean HTML)
    const cleanHtml = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<span[^>]*>/g, '').replace(/<\/span>/g, '');
    const scoreDivRegex = />([A-Z]{3,4})\s*<\/div>\s*<div[^>]*>\s*([\d\/]+)\s*\(([\d.]+)\)/g;
    let sm;
    let foundA = 0;
    while ((sm = scoreDivRegex.exec(cleanHtml)) !== null) {
        foundA++;
        scoreList.push({
            inning: sm[1],
            r: parseInt(sm[2].split('/')[0]),
            w: parseInt(sm[2].split('/')[1] || '0'),
            o: parseFloat(sm[3])
        });
    }
    if (foundA > 0) console.log(`[Scraper] Strategy A (Divs) found ${foundA} scores.`);

    // Strategy B: Fallback to Meta Description/Title
    if (scoreList.length === 0) {
        // Updated regex: Handle multiple parentheses (e.g., player stats) by being more specific
        // We look for TEAM SCORE followed optionally by (OVERS)
        const metaScoreRegex = /([A-Z]{2,10})\s+([\d\/]+)(?:\s*\(([\d\.]+)\))?/ig;
        let smMatch;
        let foundB = 0;
        while ((smMatch = metaScoreRegex.exec(desc)) !== null) {
            const team = smMatch[1].toUpperCase();
            // Filter out common player-stat keywords or names matching team pattern
            if (['MILLER', 'SMITH', 'WARNER', 'KOHLI', 'KHAN'].includes(team)) continue;

            const scorePart = smMatch[2].trim();
            foundB++;
            scoreList.push({
                inning: team,
                r: parseInt(scorePart.split(/[\/-]/)[0]),
                w: parseInt(scorePart.split(/[\/-]/)[1] || '0'),
                o: parseFloat(smMatch[3] || '0')
            });
        }
        if (foundB > 0) console.log(`[Scraper] Strategy B (Meta) found ${foundB} scores.`);
    }

    // Strategy C: Absolute last resort
    if (scoreList.length === 0) {
        // Updated regex: Overs part is now optional
        const broadRegex = /([A-Z]{2,10})\s+([\d\-\/]+)(?:\s*\(([\d.]+)\))?/ig;
        let smMatch;
        let foundC = 0;
        while ((smMatch = broadRegex.exec(html)) !== null) {
            const team = smMatch[1].toUpperCase();
            if (['FOLLOW', 'COMMENTARY', 'CRICKET', 'MATCH'].includes(team)) continue;
            
            foundC++;
            scoreList.push({
                inning: team,
                r: parseInt(smMatch[2].split(/[\/-]/)[0]),
                w: parseInt(smMatch[2].split(/[\/-]/)[1] || '0'),
                o: parseFloat(smMatch[3] || '0')
            });
        }
        if (foundC > 0) console.log(`[Scraper] Strategy C (Broad) found ${foundC} scores.`);
    }

    // Filter scoreList to only include teams relevant to this match (exclude players/excess info)
    const filteredScores = scoreList.filter(s => {
        // Use the robust isTeamMatch logic previously defined in this script
        return isTeamMatch(s.inning, teamA) || isTeamMatch(s.inning, teamB);
    });

    // 7. Extract Team Info (Abbr and Names)
    const teams = [];
    const getAbbr = (name) => {
        for (const [abbr, full] of Object.entries(IPL_TEAM_MAP)) {
            if (isTeamMatch(name, full)) return abbr;
        }
        return name.slice(0, 3).toUpperCase();
    };

    teams.push({ shortname: getAbbr(teamA), name: teamA });
    teams.push({ shortname: getAbbr(teamB), name: teamB });

    // Determine Match Winner
    let matchWinner = null;
    if (status.toLowerCase().includes('won by')) {
        matchWinner = status.split(' won by')[0].trim();
    }

    return {
        status: 'success',
        data: {
          id: path, // Use path as ID
          status: status,
          tossWinner,
          tossChoice,
          matchWinner,
          score: filteredScores,
          teamInfo: teams,
          name: title
        }
    };
  } catch (err) {
    return { status: 'failure', reason: err.message };
  }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- MONITOR LOOP ---

const runMonitor = async () => {
  console.log("=== STARTING CRICBUZZ SCRAPER MONITOR (Production) ===");
  setupFirebase();
  const db = admin.database();
  const ROOM = process.env.FIREBASE_ROOM || "ipl";

  console.log(`[Firebase] Target Room: ${ROOM}`);
  console.log(`[Firebase] Prediction Link: https://overlaychat-6f3c1.web.app/host.html?room=${ROOM}`);

  const schedule = getSchedule();
  const now = process.env.TEST_DATE ? new Date(process.env.TEST_DATE) : new Date();
  
  // IST Conversion
  const istOffset = 5.5 * 60 * 60 * 1000;
  let istTime = new Date(now.getTime() + istOffset);
  istTime = new Date(istTime.getTime() + (new Date().getTimezoneOffset() * 60 * 1000));

  const dd = String(istTime.getDate()).padStart(2, '0');
  const mm = String(istTime.getMonth() + 1).padStart(2, '0');
  const yyyy = istTime.getFullYear();
  const todayStr = `${dd}-${mm}-${yyyy}`;

  const todaysMatches = schedule.filter(m => m.date === todayStr);

  if (!todaysMatches.length) {
    console.log(`No match found for today (${todayStr}). Exiting.`);
    process.exit(0);
  }

  // --- DOUBLE HEADER / RESUME LOGIC ---
  // Always start from index 0 and let the outer while loop advance to Match 2 organically.
  // On resume, check Firebase to see if Match 1 is already finished so we can jump to Match 2.
  let targetMatchIdx = 0;
  if (todaysMatches.length > 1) {
    const state0Snap = await db.ref(`rooms/${ROOM}/monitor_state`).once("value");
    const state0 = state0Snap.val();
    const metaSnap0 = await db.ref(`rooms/${ROOM}/meta`).once("value");
    const meta0 = metaSnap0.val();
    const historySnap0 = await db.ref(`rooms/${ROOM}/history/${todaysMatches[0].matchNo}`).once("value");

    const isMatch0Finished = state0 && state0.matchNo === todaysMatches[0].matchNo && state0.finished;
    // Fallback: if the room meta already shows Match 2's teams, Match 1 was manually resolved
    const isRoomOnMatch2 = meta0 && isTeamMatch(meta0.teamA, todaysMatches[1].home);
    // Most reliable: Match 1's history node already exists in Firebase (written by auto or manual resolve)
    const isMatch0Archived = historySnap0.exists();

    if (isMatch0Finished || isRoomOnMatch2 || isMatch0Archived) {
      if (isMatch0Archived && !isMatch0Finished) {
        console.log(`[Double-Header] Match 1 (${todaysMatches[0].home}) found in history archive. Skipping to Match 2.`);
      } else if (isRoomOnMatch2 && !isMatch0Finished) {
        console.log(`[Double-Header] Room is already on Match 2 (${todaysMatches[1].home}). Match 1 was manually resolved. Skipping.`);
      } else {
        console.log(`[Double-Header] Match 1 (${todaysMatches[0].home}) is already resolved. Starting from Match 2.`);
      }
      targetMatchIdx = 1;
    } else {
      console.log(`[Double-Header] Match 1 (${todaysMatches[0].home}) is active or not yet started. Beginning with Match 1.`);
    }
  }

  let targetMatch = todaysMatches[targetMatchIdx];

  if (!targetMatch) {
    console.log(`No match found for today (${todayStr}). Exiting.`);
    process.exit(0);
  }

  while (targetMatchIdx < todaysMatches.length) {
    targetMatch = todaysMatches[targetMatchIdx];
    console.log(`Target Match: ${targetMatch.home} vs ${targetMatch.away}`);

    let matchPath = null;
  while (!matchPath) {
    try {
      const res = await scrapeCricbuzzMatch(targetMatch.home, targetMatch.away);
      if (res.status === 'success') {
          matchPath = res.data.id;
          console.log(`[Discovery] Linked to Match: ${res.data.name}`);
      } else {
          console.log(`[Discovery] Match not found yet. Retrying in 3 mins.`);
          await sleep(3 * 60 * 1000);
      }
    } catch (err) {
      console.error("[Discovery Error]", err.message);
      await sleep(1 * 60 * 1000);
    }
  }

  let isTossConfirmed = false;
  let battingTeamFull = "";
  let isFirstInningsLocked = false;
  let isSecondInningsLocked = false;
  let firstInningsResolved = false;
  let hasSleptInnings1 = false;
  let hasSleptInnings2 = false;
  let predictionsOpenedAt = null; // timestamp (ms) when predictions were opened for this match
  let chasingTeam = ""; 

  // --- RESUME CHECK ---
  console.log("[Resume] Checking for existing match state in Firebase...");
  const metaSnap = await db.ref(`rooms/${ROOM}/meta`).once("value");
  const meta = metaSnap.val();
  if (meta && isTeamMatch(meta.teamA, targetMatch.home) && isTeamMatch(meta.teamB, targetMatch.away)) {
      console.log(`[Resume] Found active session for ${targetMatch.home} vs ${targetMatch.away}.`);
      isTossConfirmed = true;
      firstInningsResolved = Boolean(meta.secondInnings);
      isFirstInningsLocked = Boolean(meta.predictionsPaused) && !firstInningsResolved;
      isSecondInningsLocked = Boolean(meta.predictionsPaused) && firstInningsResolved;
      console.log(`[Resume] Status: ${firstInningsResolved ? '2nd' : '1st'} Innings | Locked: ${meta.predictionsPaused}`);
      
      // Reconstruct battingTeamFull from metadata by accounting for swapped flags
      if (meta.secondInnings) {
          battingTeamFull = meta.disableScoreB ? meta.teamB : meta.teamA;
      } else {
          battingTeamFull = meta.disableScoreB ? meta.teamA : meta.teamB;
      }
      console.log(`[Resume] Identified Batting First: ${battingTeamFull}`);
      chasingTeam = isTeamMatch(targetMatch.home, battingTeamFull) ? targetMatch.away : targetMatch.home;
  }

  console.log("--- ENTERING MONITOR LOOP ---");

  while (true) {
    try {
      const res = await scrapeCricbuzzMatch(targetMatch.home, targetMatch.away, matchPath);
      if (res.status === 'failure') throw new Error(res.reason);

      let { tossWinner, tossChoice, matchWinner, score, status } = res.data;

      const scoreStr = score && score.length > 0 
        ? score.map(s => `${s.inning}: ${s.r}/${s.w} (${s.o} ov)`).join(" | ") 
        : "No score yet";
      console.log(`[Poll] Status: "${status}" | Score: [${scoreStr}]`);

      // 1. TOSS
      if (!isTossConfirmed && tossWinner && tossChoice) {
        const isHomeWinner = isTeamMatch(tossWinner, targetMatch.home);
        
        if (tossChoice.toLowerCase() === "bat") {
          battingTeamFull = isHomeWinner ? targetMatch.home : targetMatch.away;
        } else {
          // If they chose to bowl (like Rajasthan today), the OTHER team is batting
          battingTeamFull = isHomeWinner ? targetMatch.away : targetMatch.home;
        }
        
        chasingTeam = isTeamMatch(targetMatch.home, battingTeamFull) ? targetMatch.away : targetMatch.home;
        console.log(`[Toss] ${tossWinner} opted to ${tossChoice}. Batting First: ${battingTeamFull} | Chasing: ${chasingTeam}`);

        let disableScoreA = false;
        let disableScoreB = false;
        if (isTeamMatch(battingTeamFull, targetMatch.home)) {
          disableScoreB = true; // Team A batting, hide B
        } else {
          disableScoreA = true; // Team B batting, hide A
        }

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
        predictionsOpenedAt = Date.now();
      }

      if (isTossConfirmed && score && score.length > 0) {
        // Robust mapping: s1 is ALWAYS the team that batted first (battingTeamFull)
        let s1 = score.find(s => isTeamMatch(s.inning, battingTeamFull));
        
        // s2 is the other team (the chasers)
        let s2 = score.find(s => isTeamMatch(s.inning, chasingTeam));

        const activeS = s2 || s1;
        if (s2) {
          console.log(`[Live Score] Chasing: ${s2.inning} ${s2.r}/${s2.w} (${s2.o} ov) | Target: ${s1 ? s1.r + 1 : '---'}`);
        } else {
          console.log(`[Live Score] Batting First: ${s1.inning} ${s1.r}/${s1.w} (${s1.o} ov)`);
        }

        // 2. FIRST INNINGS
        if (!firstInningsResolved) {
          // Grace period: always give users at least 15 mins from toss before locking
          const graceElapsed = predictionsOpenedAt ? (Date.now() - predictionsOpenedAt) : Infinity;
          if (!isFirstInningsLocked && s1 && s1.o >= 3.0 && graceElapsed >= 15 * 60 * 1000) {
            console.log("3.0 Overs reached in 1st Innings and 15-min grace period elapsed! Locking predictions.");
            await db.ref(`rooms/${ROOM}/meta/predictionsPaused`).set(true);
            isFirstInningsLocked = true;
          } else if (!isFirstInningsLocked && s1 && s1.o >= 3.0) {
            console.log(`[Grace] 3.0 Overs reached but grace period active. ${Math.round((15 * 60 * 1000 - graceElapsed) / 1000 / 60)} min(s) remaining.`);
          }

          const isInningsBreak = status.toLowerCase().includes("innings break") || s2;
          if (s1.o >= 19.6 || s1.w >= 10 || isInningsBreak) {
            const predSnap = await db.ref(`rooms/${ROOM}/predictions`).once("value");
            const preds = predSnap.val() || {};
            const metaSnap = await db.ref(`rooms/${ROOM}/meta`).once("value");
            const meta = metaSnap.val() || {};

            for (let pid in preds) {
              const stats = calculateInnings1Points(preds[pid], s1.r, meta);
              preds[pid] = { ...preds[pid], ...stats, points: stats.points };
            }
            await db.ref(`rooms/${ROOM}/innings_history/1st`).set(preds);
            await db.ref(`rooms/${ROOM}/predictions`).remove();
            
            // Swap score fields for 2nd innings
            await db.ref(`rooms/${ROOM}/meta`).update({ 
                secondInnings: true, 
                predictionsPaused: false,
                disableScoreA: !meta.disableScoreA,
                disableScoreB: !meta.disableScoreB
            });
            firstInningsResolved = true;
          }
        }
        // 3. SECOND INNINGS
        else if (s2) {
          if (!isSecondInningsLocked && s2.o >= 3.0) {
            console.log("3.0 Overs reached in 2nd Innings! Locking predictions.");
            await db.ref(`rooms/${ROOM}/meta/predictionsPaused`).set(true);
            isSecondInningsLocked = true;
          }

          if (s2.o >= 19.6 || s2.w >= 10 || matchWinner || (s1 && s2.r > s1.r)) {
            // If the chasing team mathematically crossed the target, hard-declare them the winner
            if (!matchWinner && s1 && s2.r > s1.r) {
                matchWinner = chasingTeam;
            }
            console.log(`Match complete. Winner: ${matchWinner}`);
            const isChaserWinner = matchWinner && !isTeamMatch(matchWinner, battingTeamFull);

            // Resolve matchWinner to the exact short name (teamA or teamB) used in predictions
            let resolvedActualWinner = null;
            if (matchWinner) {
                if (isTeamMatch(matchWinner, targetMatch.home)) resolvedActualWinner = targetMatch.home;
                else if (isTeamMatch(matchWinner, targetMatch.away)) resolvedActualWinner = targetMatch.away;
            }

            const metaSnap = await db.ref(`rooms/${ROOM}/meta`).once("value");
            const meta = metaSnap.val() || {};

            const predSnap = await db.ref(`rooms/${ROOM}/predictions`).once("value");
            const preds = predSnap.val() || {};
            const actualResult = isChaserWinner ? s2.o : s2.r;

            for (let pid in preds) {
              const stats = calculateInnings2Points(preds[pid], resolvedActualWinner, actualResult, meta, isChaserWinner);
              preds[pid] = { ...preds[pid], ...stats, points: stats.points };
            }

            await db.ref(`rooms/${ROOM}/innings_history/2nd`).set(preds);
            
            // Native auto-archiving for double-headers to safely clear the board
            console.log("Aggregating finals and backing up to History...");
            const h1Snap = await db.ref(`rooms/${ROOM}/innings_history/1st`).once("value");
            const finalH1 = h1Snap.val() || {};
            const finals = calculateMatchFinals(finalH1, preds);

            // Construct proper archive payload (same structure as manual archival in control.js)
            const dateKey = `${todayStr.split('-').reverse().join('-')}_${Date.now()}`;
            const archivePayload = {
              archivedAt: Date.now(),
              matchTitle: targetMatch.titleStr || "Unnamed Match",
              teamA: targetMatch.home,
              teamB: targetMatch.away,
              innings1: finalH1,
              innings2: preds,
              finalStandings: finals,
              matchResults: {
                actual1st: s1 ? s1.r : 0,
                actual2nd: actualResult,
                actualWinner: resolvedActualWinner
              }
            };

            await db.ref(`rooms/${ROOM}/history/${targetMatch.matchNo}`).set(finals);
            console.log("Match fully resolved and successfully archived!");

            // Trigger season leaderboard sync
            console.log("Triggering Season Leaderboard sync...");
            await syncSeasonLeaderboard(db, ROOM);
            
            // Wipe Live Game Nodes (to mimic 'End Match' behavior)
            await db.ref(`rooms/${ROOM}/predictions`).remove();
            await db.ref(`rooms/${ROOM}/innings_history`).remove();
            await db.ref(`rooms/${ROOM}/meta`).update({ matchTitle: '', predictionsPaused: false });
            
            await db.ref(`rooms/${ROOM}/monitor_state`).set({ matchNo: targetMatch.matchNo, finished: true });
            
            // Note: Season Leaderboard update takes a bit safely done on next dashboard load, 
            // but we could technically run a sync here.
            console.log("Match fully resolved and successfully archived! Awaiting transition to Match 2.");
            break;
          }
        }
      }

      // --- DYNAMIC POLLING ---
      let delay = 3 * 60 * 1000; // Default 3 mins
      
      if (!isTossConfirmed) {
        delay = 3 * 60 * 1000;
      } else {
        const s1 = score && score.find(s => isTeamMatch(s.inning, battingTeamFull));
        const s2 = score && score.find(s => isTeamMatch(s.inning, chasingTeam));
        
        if (!firstInningsResolved && s1) {
           if (s1.o < 0.1 && !hasSleptInnings1) {
              console.log("[Sleep] Waiting 20 mins for match start...");
              delay = 20 * 60 * 1000;
              hasSleptInnings1 = true; 
           } else if (s1.o >= 3.0 && s1.o < 18.0) {
              delay = 10 * 60 * 1000;
           } else if (s1.o >= 18.0) {
              delay = 1 * 60 * 1000;
           }
        } 
        else if (firstInningsResolved && s2) {
           if (s2.o < 0.1 && !hasSleptInnings2) {
              console.log("[Sleep] Waiting 20 mins for 2nd innings start...");
              delay = 20 * 60 * 1000;
              hasSleptInnings2 = true;
           } else {
              // In a chase, if the team is within 15 runs of the target, poll every 1 min
              // so we catch an early win without waiting up to 10 mins
              const target2 = s1 ? s1.r + 1 : null;
              const runsNeeded = target2 !== null ? target2 - s2.r : Infinity;
              if (runsNeeded <= 15) {
                 console.log(`[Fast-Poll] Chasing team needs only ${runsNeeded} runs. Polling every 1 min.`);
                 delay = 1 * 60 * 1000;
              } else if (s2.o >= 3.0 && s2.o < 18.0) {
                 delay = 10 * 60 * 1000;
              } else if (s2.o >= 18.0) {
                 delay = 1 * 60 * 1000;
              }
           }
        }
      }

      console.log(`Sleeping for ${Math.round(delay / 1000 / 60)} mins...`);
      await sleep(delay);

    } catch (err) {
      console.error(`[Monitor Error] ${err.message}. Retrying in 3 mins.`);
      await sleep(3 * 60 * 1000);
    }
  }

  targetMatchIdx++;
  if (targetMatchIdx < todaysMatches.length) {
      console.log(`[Double-Header] Match ${targetMatchIdx} complete. Transitioning immediately into Match ${targetMatchIdx + 1}.`);
  }
} // outer loop end

  console.log("All matches for today completed successfully. Exiting.");
  process.exit(0);
};

/**
 * Recalculates the season leaderboard by aggregating all historical matches.
 */
async function syncSeasonLeaderboard(db, room) {
  try {
    const historySnap = await db.ref(`rooms/${room}/history`).once('value');
    const history = historySnap.val() || {};
    
    const seasonMap = new Map();
    
    // Iterate through all matches in history
    Object.entries(history).forEach(([key, match]) => {
      // Standard: We only process primary match records (containing '-') 
      // to avoid double-counting if numeric backup keys exist.
      if (!key.includes('-')) return;
      
      const standings = match && match.finalStandings ? match.finalStandings : [];
      
      standings.forEach(r => {
        if (!r.name) return;
        const nameKey = r.name.trim().toLowerCase();
        if (!seasonMap.has(nameKey)) {
          seasonMap.set(nameKey, { name: r.name, total: 0, matchCount: 0 });
        }
        const player = seasonMap.get(nameKey);
        player.total += (r.total || 0);
        player.matchCount += 1;
      });
    });

    const players = Array.from(seasonMap.values()).map(p => ({
      ...p,
      ppg: Number((p.total / (p.matchCount || 1)).toFixed(2))
    }));

    // Sort by total points (consistent with control.js)
    const sorted = players.sort((a, b) => b.total - a.total);

    // Persist to Firebase
    await db.ref(`rooms/${room}/season_leaderboard`).set(sorted);
    console.log(`[Leaderboard] Successfully synced stats for ${sorted.length} players.`);
  } catch (err) {
    console.error(`[Leaderboard Error] Failed to sync: ${err.message}`);
  }
}

module.exports = { scrapeCricbuzzMatch, syncSeasonLeaderboard };
if (require.main === module) {
  runMonitor();
}
