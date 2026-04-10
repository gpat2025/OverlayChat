require("dotenv").config();
const https = require('https');
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const { calculateInnings1Points, calculateInnings2Points, calculateMatchFinals } = require("./scoring.js");
const util = require("util");

// --- FORCE REAL-TIME LOG OUTPUT ---
console.log = (...args) => { process.stdout.write(util.format(...args) + "\n"); };
console.error = (...args) => { process.stderr.write(util.format(...args) + "\n"); };
console.warn = (...args) => { process.stderr.write(util.format(...args) + "\n"); };

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

/**
 * Robustly checks if a candidate team string matches a target team string.
 * Handles abbreviations, initials, and full names.
 */
const isTeamMatch = (candidate, target) => {
  if (!candidate || !target) return false;
  const c = candidate.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  
  // 1. Direct or substring match
  if (c.includes(t) || t.includes(c)) return true;
  
  // 2. Initials (e.g., "GT" matches "Gujarat Titans")
  const initialsOfCandidate = c.split(/\s+/).map(w => w[0]).join("");
  const initialsOfTarget = t.split(/\s+/).map(w => w[0]).join("");
  
  if (initialsOfCandidate === t || initialsOfTarget === c) return true;
  
  // 3. First word match (e.g., "Kolkata" matches "Kolkata Knight Riders")
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
        // Match "opted to bowl/bat" specifically for toss
        />\s*([^<]*opted to (?:bat|bowl)[^<]*)\s*</i,
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
        />\s*([^<.]+)won the toss and opted to (bat|bowl)/i,
        />\s*([^<.]+)opt to (bat|bowl)/i,
        />\s*([^<.]+)opted to (bat|bowl)/i
    ];
    for (const pat of tossPatterns) {
        const tm = html.match(pat);
        if (tm) {
            tossWinner = tm[1].trim();
            tossChoice = tm[2].trim();
            break;
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
        const inn = s.inning.toLowerCase();
        const tA = teamA.toLowerCase();
        const tB = teamB.toLowerCase();
        
        // 1. Direct match or substring (e.g., "Oman" matches "Oman")
        if (tA.includes(inn) || tB.includes(inn)) return true;
        
        // 2. Initials (e.g., "GT" matches "Gujarat Titans")
        const initialsA = tA.split(/\s+/).map(w => w[0]).join("");
        const initialsB = tB.split(/\s+/).map(w => w[0]).join("");
        if (inn === initialsA || inn === initialsB) return true;
        
        // 3. Fallback: Check if inn is a valid abbreviation of the team (starts with 3 letters)
        return inn.includes(tA.slice(0, 3)) || inn.includes(tB.slice(0, 3));
    });

    // 7. Extract Team Info (Abbr and Names)
    // We try to find codes and full names from the title or description
    const teams = [];
    const teamInfoRegex = /([A-Z]{2,4})\s+vs\s+([A-Z]{2,4})/i;
    const tim = title.match(teamInfoRegex);
    if (tim) {
        teams.push({ shortname: tim[1], name: tim[1] }); // Simplified
        teams.push({ shortname: tim[2], name: tim[2] });
    }

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

  let todaysMatches = schedule.filter(m => m.date === todayStr);

  const hours = istTime.getHours();
  const matchIdx = (todaysMatches.length > 1 && hours >= 16) ? 1 : 0;
  const targetMatch = todaysMatches[matchIdx];

  if (!targetMatch) {
    console.log(`No match found for today (${todayStr}). Exiting.`);
    process.exit(0);
  }

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
  }

  console.log("--- ENTERING MONITOR LOOP ---");

  while (true) {
    try {
      const res = await scrapeCricbuzzMatch(targetMatch.home, targetMatch.away, matchPath);
      if (res.status === 'failure') throw new Error(res.reason);

      const { tossWinner, tossChoice, matchWinner, score, status } = res.data;

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
        
        console.log(`[Toss] ${tossWinner} opted to ${tossChoice}. Batting First: ${battingTeamFull}`);

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
      }

      if (isTossConfirmed && score && score.length > 0) {
        const s1 = score[0];
        const s2 = score[1];
        const activeS = s2 || s1;
        console.log(`[Live Score] ${activeS.inning}: ${activeS.r}/${activeS.w} (${activeS.o} ov)`);

        // 2. FIRST INNINGS
        if (!firstInningsResolved) {
          if (!isFirstInningsLocked && s1 && s1.o >= 3.0) {
            console.log("3.0 Overs reached in 1st Innings! Locking predictions.");
            await db.ref(`rooms/${ROOM}/meta/predictionsPaused`).set(true);
            isFirstInningsLocked = true;
          }

          const isInningsBreak = status.toLowerCase().includes("innings break") || s2;
          if (s1.o >= 19.6 || s1.w >= 10 || isInningsBreak) {
            console.log("1st Innings complete. Resolving scores...");
            const predSnap = await db.ref(`rooms/${ROOM}/predictions`).once("value");
            const preds = predSnap.val() || {};
            for (let pid in preds) {
              const stats = calculateInnings1Points(preds[pid], s1.r, {});
              preds[pid] = { ...preds[pid], ...stats, points: stats.points };
            }
            await db.ref(`rooms/${ROOM}/innings_history/1st`).set(preds);
            await db.ref(`rooms/${ROOM}/predictions`).remove();
            
            // Swap score fields for 2nd innings
            const metaSnap = await db.ref(`rooms/${ROOM}/meta`).once("value");
            const oldMeta = metaSnap.val() || {};
            await db.ref(`rooms/${ROOM}/meta`).update({ 
                secondInnings: true, 
                predictionsPaused: false,
                disableScoreA: !oldMeta.disableScoreA,
                disableScoreB: !oldMeta.disableScoreB
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

          if (s2.o >= 19.6 || s2.w >= 10 || matchWinner) {
            console.log(`Match complete. Winner: ${matchWinner}`);
            const isChaserWinner = matchWinner && !matchWinner.toLowerCase().includes(s1.inning.toLowerCase());

            const predSnap = await db.ref(`rooms/${ROOM}/predictions`).once("value");
            const preds = predSnap.val() || {};
            const actualResult = isChaserWinner ? s2.o : s2.r;

            for (let pid in preds) {
              const stats = calculateInnings2Points(preds[pid], "---", actualResult, {}, isChaserWinner);
              preds[pid] = { ...preds[pid], ...stats, points: stats.points };
            }

            await db.ref(`rooms/${ROOM}/innings_history/2nd`).set(preds);
            await db.ref(`rooms/${ROOM}/predictions`).remove();
            await db.ref(`rooms/${ROOM}/monitor_state`).set({ matchNo: targetMatch.matchNo, finished: true });
            console.log("Match fully resolved. Exiting.");
            process.exit(0);
          }
        }
      }

      // --- DYNAMIC POLLING ---
      let delay = 3 * 60 * 1000; // Default 3 mins
      
      if (!isTossConfirmed) {
        delay = 3 * 60 * 1000;
      } else {
        const s1 = score && score[0];
        const s2 = score && score[1];
        
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
           } else if (s2.o >= 3.0 && s2.o < 18.0) {
              delay = 10 * 60 * 1000;
           } else if (s2.o >= 18.0) {
              delay = 1 * 60 * 1000;
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
};

module.exports = { scrapeCricbuzzMatch };
if (require.main === module) {
  runMonitor();
}
