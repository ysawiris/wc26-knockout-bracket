#!/usr/bin/env node
/* ============================================================
   Fetches 2026 World Cup group-stage matches and writes the
   compact data/live.json the site reads.

   Primary source: FIFA's public API (api.fifa.com) — no token,
   gives kickoff times, live scores AND card events (the league
   tiebreaker), so the whole pipeline is hands-off.

   Fallback: football-data.org, used only if the FIFA call fails
   and env FOOTBALL_DATA_TOKEN is set (scores only, no cards).

   Never hard-fails: on any error it exits 0 leaving the previous
   data/live.json in place.
   ============================================================ */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = `${ROOT}/data/live.json`;

/* ---------------- FIFA (primary, tokenless) ---------------- */

const FIFA_BASE = "https://api.fifa.com/api/v3";
const FIFA_COMPETITION = "17"; // FIFA World Cup
const FIFA_SEASON = "285023"; // FIFA World Cup 2026

/* MatchStatus: 0 = finished, 3 = live, 1 = scheduled.
   Period 4 = half-time (used to refine the live label). */
function fifaStatus(m) {
  if (m.MatchStatus === 0) return "FINISHED";
  if (m.MatchStatus === 3) return m.Period === 4 ? "PAUSED" : "IN_PLAY";
  return "TIMED";
}

/* Timeline event types (verified against the MEX–RSA timeline, 2026-06-12):
   2 = yellow card ("is booked"), 3 = red card ("is sent off"),
   18 = foul ("commits a foul"). Each foul event carries IdTeam, so the
   per-country split is reliable. NOTE: type 5 is a substitution, not a
   foul — the earlier EVENT_FOUL = 5 was silently counting subs (≤5/team),
   which is why foul totals looked implausibly low. */
const EVENT_YELLOW = 2;
const EVENT_RED = 3;
const EVENT_FOUL = 18;

function loc(arr) {
  return (Array.isArray(arr) && arr[0] && arr[0].Description) || null;
}

function groupLetter(m) {
  const g = loc(m.GroupName) || "";
  const hit = g.match(/^Group ([A-L])$/);
  return hit ? hit[1] : null;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/* Count yellow/red cards per country name for one match. */
async function fetchMatchCards(m, teamCountry) {
  const url = `${FIFA_BASE}/timelines/${FIFA_COMPETITION}/${FIFA_SEASON}/${m.IdStage}/${m.IdMatch}?language=en`;
  const data = await fetchJson(url);
  const events = Array.isArray(data.Event) ? data.Event : [];

  const counts = {};
  events.forEach((e) => {
    if (e.Type !== EVENT_YELLOW && e.Type !== EVENT_RED && e.Type !== EVENT_FOUL) return;
    const country = teamCountry[e.IdTeam];
    if (!country) return;
    const c = counts[country] || (counts[country] = { y: 0, r: 0, f: 0 });
    if (e.Type === EVENT_YELLOW) c.y += 1;
    else if (e.Type === EVENT_RED) c.r += 1;
    else c.f += 1;
  });
  return counts;
}

async function fetchFifa(prevCardsByMatch) {
  const url =
    `${FIFA_BASE}/calendar/matches?idCompetition=${FIFA_COMPETITION}` +
    `&idSeason=${FIFA_SEASON}&count=200&language=en`;
  const data = await fetchJson(url);
  const raw = Array.isArray(data.Results) ? data.Results : [];

  const matches = [];
  const cardsByMatch = {};

  for (const m of raw) {
    const group = groupLetter(m);
    if (!group) continue; // group stage only — Group A shows as exhibition client-side

    const home = loc(m.Home && m.Home.TeamName) || "TBD";
    const away = loc(m.Away && m.Away.TeamName) || "TBD";
    const status = fifaStatus(m);
    const counted = status === "FINISHED" || status === "IN_PLAY" || status === "PAUSED";

    matches.push({
      id: m.IdMatch,
      group,
      matchday: null, // the site derives matchday from its fixture pattern
      utcDate: m.Date || null,
      status,
      home,
      away,
      homeGoals: m.HomeTeamScore == null ? null : m.HomeTeamScore,
      awayGoals: m.AwayTeamScore == null ? null : m.AwayTeamScore,
      venue: loc(m.Stadium && m.Stadium.Name),
      minute: m.MatchTime || null
    });

    // Cards only exist once a match is underway. One timeline call per
    // counted match; on failure, fall back to the previous run's counts.
    if (counted) {
      const teamCountry = {};
      if (m.Home) teamCountry[m.Home.IdTeam] = home;
      if (m.Away) teamCountry[m.Away.IdTeam] = away;
      try {
        cardsByMatch[m.IdMatch] = await fetchMatchCards(m, teamCountry);
      } catch (err) {
        console.error(`Timeline fetch failed for ${home} v ${away}: ${err.message}`);
        if (prevCardsByMatch[m.IdMatch]) cardsByMatch[m.IdMatch] = prevCardsByMatch[m.IdMatch];
      }
    }
  }

  const byCountry = {};
  const foulsByCountry = {};
  Object.values(cardsByMatch).forEach((perMatch) => {
    Object.entries(perMatch).forEach(([country, c]) => {
      const agg = byCountry[country] || (byCountry[country] = { y: 0, r: 0 });
      agg.y += c.y;
      agg.r += c.r;
      if (c.f) {
        const fa = foulsByCountry[country] || (foulsByCountry[country] = { f: 0 });
        fa.f += c.f;
      }
    });
  });

  return {
    source: "fifa.com",
    matches,
    cards: { byMatch: cardsByMatch, byCountry },
    fouls: { byCountry: foulsByCountry }
  };
}

/* ---------------- football-data.org (fallback) ---------------- */

function normGroup(m) {
  const g = m.group || m.stage || "";
  const match = String(g).match(/GROUP[_\s]?([A-L])/i) || String(g).match(/([A-L])\b/i);
  return match ? match[1].toUpperCase() : null;
}

async function fetchFootballData() {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return null;

  const data = await fetchJson2(
    "https://api.football-data.org/v4/competitions/WC/matches",
    { "X-Auth-Token": token }
  );
  const raw = Array.isArray(data.matches) ? data.matches : [];

  const matches = raw
    .map((m) => {
      const group = normGroup(m);
      if (!group) return null;
      const ft = (m.score && m.score.fullTime) || {};
      return {
        id: String(m.id),
        group,
        matchday: m.matchday || null,
        utcDate: m.utcDate || null,
        status: m.status || "SCHEDULED",
        home: m.homeTeam ? (m.homeTeam.name || m.homeTeam.shortName || "TBD") : "TBD",
        away: m.awayTeam ? (m.awayTeam.name || m.awayTeam.shortName || "TBD") : "TBD",
        homeGoals: ft.home == null ? null : ft.home,
        awayGoals: ft.away == null ? null : ft.away,
        venue: m.venue || null,
        minute: null
      };
    })
    .filter(Boolean);

  return { source: "football-data.org", matches, cards: null };
}

async function fetchJson2(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/* ---------------- main ---------------- */

async function main() {
  let prev = null;
  try {
    prev = JSON.parse(await readFile(OUT, "utf8"));
  } catch (_) {}
  const prevCardsByMatch = (prev && prev.cards && prev.cards.byMatch) || {};

  let result = null;
  try {
    result = await fetchFifa(prevCardsByMatch);
  } catch (err) {
    console.error("FIFA fetch failed:", err.message);
    try {
      result = await fetchFootballData();
      if (!result) console.log("No FOOTBALL_DATA_TOKEN fallback configured.");
    } catch (err2) {
      console.error("football-data fallback failed too:", err2.message);
    }
  }

  if (!result || !result.matches.length) {
    console.log("No data fetched — leaving existing live.json untouched.");
    return;
  }

  // Skip writing if nothing meaningful changed (keeps git history clean).
  if (
    prev &&
    JSON.stringify(prev.matches) === JSON.stringify(result.matches) &&
    JSON.stringify((prev.cards && prev.cards.byCountry) || null) ===
      JSON.stringify((result.cards && result.cards.byCountry) || null) &&
    JSON.stringify((prev.fouls && prev.fouls.byCountry) || null) ===
      JSON.stringify((result.fouls && result.fouls.byCountry) || null)
  ) {
    console.log(`No changes (${result.matches.length} matches). Nothing to write.`);
    return;
  }

  const payload = {
    source: result.source,
    competition: "FWC2026",
    fetchedAt: new Date().toISOString(),
    matchCount: result.matches.length,
    matches: result.matches,
    cards: result.cards,
    fouls: result.fouls || null
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    `Wrote ${result.matches.length} matches from ${result.source}` +
      (result.cards ? ` (cards for ${Object.keys(result.cards.byMatch).length} matches)` : "")
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exitCode = 0; // never break the cron on a bad run
});
