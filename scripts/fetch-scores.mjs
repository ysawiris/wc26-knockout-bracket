#!/usr/bin/env node
/*
  fetch-scores.mjs — durable live baseline for the knockout hub.

  Pulls the 2026 FIFA World Cup KNOCKOUT matches from FIFA's public API and
  writes data/live.json. The app reads that file (network-first) on every load:
  Live.attachToFixtures overlays scores/status onto the bracket fixtures, and
  the BB2 auto-advance (deriveResults + applyAutoResults) advances the winner of
  any FINISHED match — so finished games show their score AND the bracket +
  standings update on their own, with no manual entry.

  This is the durable layer (works even when nobody has the site open and well
  after kickoff); the browser-direct js/live-direct.js still overlays faster
  in-play updates during the ~kickoff..+2h match window.

  Cards/fouls are intentionally left empty: in knockout mode they are display-
  only and never score, and the in-play browser layer fills them live.

  No dependencies. Needs Node 18+ (global fetch). A GitHub Action runs it on a
  cron and commits data/live.json only when the scores actually change.
*/

import { writeFileSync, readFileSync } from "node:fs";

const COMPETITION = "17";   // FIFA World Cup
const SEASON = "285023";    // 2026 edition
const CAL_URL =
  `https://api.fifa.com/api/v3/calendar/matches?idCompetition=${COMPETITION}` +
  `&idSeason=${SEASON}&count=200&language=en`;
const OUT = "data/live.json";

const loc = (arr) => (arr && arr[0] && arr[0].Description) || null;

// FIFA MatchStatus: 0 = finished, 3 = live (Period 4 = half-time), else not started.
function statusOf(m) {
  if (m.MatchStatus === 0) return "FINISHED";
  if (m.MatchStatus === 3) return m.Period === 4 ? "PAUSED" : "IN_PLAY";
  return "TIMED";
}

// Keep only knockout matches — the bracket has no group fixtures to match.
function isKnockout(m) {
  const s = (loc(m.StageName) || "").toLowerCase();
  return /round of 32|round of 16|quarter|semi|final/.test(s);
}

function mapMatch(m) {
  const decided = m.MatchStatus === 0 || m.MatchStatus === 3; // only show scores once played
  return {
    id: m.IdMatch,
    round: loc(m.StageName),
    status: statusOf(m),
    home: loc(m.Home && m.Home.TeamName) || "TBD",
    away: loc(m.Away && m.Away.TeamName) || "TBD",
    homeGoals: decided && m.HomeTeamScore != null ? m.HomeTeamScore : null,
    awayGoals: decided && m.AwayTeamScore != null ? m.AwayTeamScore : null,
    utcDate: m.Date || null,
    venue: loc(m.Stadium && m.Stadium.Name),
    minute: m.MatchTime || null
  };
}

async function main() {
  const res = await fetch(CAL_URL, { headers: { accept: "application/json" } });
  if (!res.ok) {
    console.error(`FIFA calendar fetch failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  const all = (data && data.Results) || [];
  const matches = all.filter(isKnockout).map(mapMatch);

  const payload = {
    source: "fifa.com",
    competition: "FWC2026-knockout",
    fetchedAt: new Date().toISOString(),
    matchCount: matches.length,
    matches,
    cards: { byCountry: {}, byMatch: {} },
    fouls: { byCountry: {} }
  };

  const next = JSON.stringify(payload, null, 2) + "\n";

  // Skip the write when only the timestamp would change, so an unchanged feed
  // never churns a commit.
  const stripTs = (s) => s.replace(/"fetchedAt":\s*"[^"]*"/, '"fetchedAt":""');
  let prev = "";
  try { prev = readFileSync(OUT, "utf8"); } catch { /* first run */ }
  if (stripTs(prev) === stripTs(next)) {
    console.log("live.json unchanged — no commit needed.");
    return;
  }

  writeFileSync(OUT, next);
  const fin = matches.filter((m) => m.status === "FINISHED").length;
  const live = matches.filter((m) => m.status === "IN_PLAY" || m.status === "PAUSED").length;
  console.log(`live.json updated: ${matches.length} knockout matches (${fin} finished, ${live} live).`);
}

main().catch((err) => {
  console.error("fetch-scores failed:", err && err.message ? err.message : err);
  process.exit(1);
});
