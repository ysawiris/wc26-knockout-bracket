#!/usr/bin/env node
/* ============================================================
   Fetches DraftKings over/under lines for the 2026 World Cup
   group stage (via ESPN's public scoreboard API) and writes the
   compact data/odds.json the site reads.

   For each tournament day it pulls the scoreboard, takes the
   first odds entry per event (DraftKings, priority 1), and
   converts the O/U line + American prices into a market-implied
   expected-goals total (vig-stripped Poisson inversion).

   Team names are mapped to the seed names used in js/data.js /
   js/schedule.js so the client can match fixtures by canon pair.

   In-play events are never recomputed (ESPN swaps in a remaining-
   goals line at kickoff) — their pre-game entry is carried forward
   from the previous data/odds.json instead.

   Never hard-fails: on any error it exits 0 leaving the previous
   data/odds.json in place.
   ============================================================ */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = `${ROOT}/data/odds.json`;

const ESPN_SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

/* Group stage runs 2026-06-11 through 2026-06-27 (UTC month is 0-based). */
const FIRST_DAY = Date.UTC(2026, 5, 11);
const LAST_DAY = Date.UTC(2026, 5, 27);
const DAY_DELAY_MS = 150; // be polite between scoreboard calls

/* impliedTotal model constants (see impliedTotal below). */
const LAMBDA_LO = 0.3;
const LAMBDA_HI = 7;
const BISECT_ITERS = 60;
const NO_PRICE_BUMP = 0.15; // line + this when prices are missing
const TOTAL_MIN = 1.6;
const TOTAL_MAX = 4.6;

/* ---------------- team-name canon ---------------- */

/* Canonical form shared with the client: lowercase, strip diacritics,
   strip everything that isn't a letter ("Bosnia & Herzegovina" and
   ESPN's "Bosnia-Herzegovina" both become "bosniaherzegovina"). */
function canon(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "");
}

/* Seed names exactly as they appear in js/data.js (groups B-L) plus
   the Group A exhibition teams from js/schedule.js. */
const SEED_NAMES = [
  /* A */ "Mexico", "South Africa", "South Korea", "Czech Republic",
  /* B */ "Canada", "Bosnia & Herzegovina", "Qatar", "Switzerland",
  /* C */ "Brazil", "Morocco", "Haiti", "Scotland",
  /* D */ "United States", "Paraguay", "Australia", "Türkiye",
  /* E */ "Germany", "Curaçao", "Ivory Coast", "Ecuador",
  /* F */ "Netherlands", "Japan", "Sweden", "Tunisia",
  /* G */ "Belgium", "Egypt", "Iran", "New Zealand",
  /* H */ "Spain", "Cape Verde", "Saudi Arabia", "Uruguay",
  /* I */ "France", "Senegal", "Iraq", "Norway",
  /* J */ "Argentina", "Algeria", "Austria", "Jordan",
  /* K */ "Portugal", "DR Congo", "Uzbekistan", "Colombia",
  /* L */ "England", "Croatia", "Ghana", "Panama"
];

/* Known API spellings that don't canon-collapse onto a seed name. */
const ALIASES = {
  bosniaandherzegovina: "Bosnia & Herzegovina",
  cotedivoire: "Ivory Coast",
  ivorycoast: "Ivory Coast",
  turkey: "Türkiye",
  usa: "United States",
  unitedstatesofamerica: "United States",
  korearepublic: "South Korea",
  czechia: "Czech Republic",
  capeverdeislands: "Cape Verde",
  caboverde: "Cape Verde",
  congodr: "DR Congo",
  democraticrepublicofthecongo: "DR Congo",
  iriran: "Iran",
  islamicrepublicofiran: "Iran"
};

const CANON_TO_SEED = (() => {
  const map = {};
  SEED_NAMES.forEach((name) => { map[canon(name)] = name; });
  Object.entries(ALIASES).forEach(([key, name]) => { map[key] = name; });
  return map;
})();

/* Raw API name -> seed name; unmapped names fall back to their canon
   form so the client's canon-pair matching still has a fair shot. */
function toSeedName(raw, unmapped) {
  const c = canon(raw);
  const seed = CANON_TO_SEED[c];
  if (seed) return seed;
  unmapped.add(raw);
  return c;
}

/* ---------------- odds math ---------------- */

/* "+120" -> 120 · "-140" -> -140 · "EVEN" -> 100 · junk -> null */
function parseAmerican(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (/^even$/i.test(s)) return 100;
  const m = /^([+-])?(\d+)$/.exec(s);
  if (!m) return null;
  const v = (m[1] === "-" ? -1 : 1) * parseInt(m[2], 10);
  return Math.abs(v) < 100 ? null : v;
}

/* American odds -> implied probability: am2p(+A) = 100/(A+100),
   am2p(-A) = A/(A+100). */
function americanToProb(odds) {
  return odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
}

/* P(X >= k) for X ~ Poisson(lambda), via the iterative pmf sum. */
function poissonTailGE(k, lambda) {
  if (k <= 0) return 1;
  let pmf = Math.exp(-lambda);
  let cdf = pmf;
  for (let i = 1; i < k; i++) {
    pmf *= lambda / i;
    cdf += pmf;
  }
  return Math.max(0, 1 - cdf);
}

/* Market expected goals for one match. Strip the vig from the O/U
   prices, then bisection-solve the Poisson rate whose tail above the
   line matches the no-vig over probability. Non-half lines round to
   the nearest 0.5 first; missing prices fall back to line + 0.15. */
function impliedTotal(line, overOdds, underOdds) {
  const L = Math.round(line * 2) / 2;
  let total;

  if (overOdds == null || underOdds == null) {
    total = L + NO_PRICE_BUMP;
  } else {
    const rawOver = americanToProb(overOdds);
    const rawUnder = americanToProb(underOdds);
    const pOver = rawOver / (rawOver + rawUnder); // vig stripped
    const k = Math.ceil(L); // over cashes at k or more goals

    let lo = LAMBDA_LO;
    let hi = LAMBDA_HI;
    for (let i = 0; i < BISECT_ITERS; i++) {
      const mid = (lo + hi) / 2;
      if (poissonTailGE(k, mid) < pOver) lo = mid;
      else hi = mid;
    }
    total = (lo + hi) / 2;
  }

  return Math.round(Math.min(Math.max(total, TOTAL_MIN), TOTAL_MAX) * 100) / 100;
}

/* ---------------- ESPN scoreboard ---------------- */

/* Once a match kicks off, ESPN swaps its pre-game total for an IN-GAME
   remaining-goals line (verified on live days) — recomputing impliedTotal
   from that would poison the forecast mid-match. status.type.state is
   "pre" / "in" / "post" on both the event and its competition; prefer
   the competition's (the odds live there too). */
function isInPlay(event) {
  const comp = Array.isArray(event.competitions) && event.competitions[0];
  const type =
    (comp && comp.status && comp.status.type) ||
    (event.status && event.status.type) ||
    null;
  return !!type && type.state === "in";
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* close price first, open as fallback; returns the American price
   string or null when neither side parses. */
function sidePrice(side) {
  if (!side) return null;
  const close = side.close && side.close.odds;
  if (parseAmerican(close) != null) return String(close).trim();
  const open = side.open && side.open.odds;
  if (parseAmerican(open) != null) return String(open).trim();
  return null;
}

/* One scoreboard event -> one odds line (or null when there's no
   usable O/U market). dayISO is the calendar day the event was
   found under — it matches the site's fixture dates. */
function extractLine(event, dayISO, unmapped) {
  const comp = Array.isArray(event.competitions) && event.competitions[0];
  if (!comp) return null;

  const competitors = Array.isArray(comp.competitors) ? comp.competitors : [];
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");
  if (!home || !home.team || !away || !away.team) return null;

  const odds = Array.isArray(comp.odds) && comp.odds[0];
  const line = odds ? Number(odds.overUnder) : NaN;
  if (!isFinite(line) || line <= 0) return null; // no O/U posted yet

  const total = odds.total || {};
  const overUS = sidePrice(total.over);
  const underUS = sidePrice(total.under);

  const homeRaw = home.team.displayName || "TBD";
  const awayRaw = away.team.displayName || "TBD";

  return {
    espnId: String(event.id),
    date: dayISO,
    home: toSeedName(homeRaw, unmapped),
    away: toSeedName(awayRaw, unmapped),
    homeRaw,
    awayRaw,
    line,
    overUS,
    underUS,
    impliedTotal: impliedTotal(line, parseAmerican(overUS), parseAmerican(underUS)),
    provider: (odds.provider && odds.provider.displayName) || null
  };
}

async function fetchAllLines(prevById) {
  const byId = new Map(); // dedupe by event id across days
  const unmapped = new Set();
  let failedDays = 0;
  let skippedNoLine = 0;
  let carriedInPlay = 0;

  for (let t = FIRST_DAY; t <= LAST_DAY; t += 86400000) {
    const dayISO = new Date(t).toISOString().slice(0, 10);
    const yyyymmdd = dayISO.replace(/-/g, "");
    try {
      const data = await fetchJson(`${ESPN_SCOREBOARD}?dates=${yyyymmdd}`);
      const events = Array.isArray(data.events) ? data.events : [];
      for (const event of events) {
        if (event.id == null || byId.has(String(event.id))) continue;
        if (isInPlay(event)) {
          /* Never recompute from an in-game line: carry forward this
             event's pre-game entry from the previous odds.json, or skip
             the event entirely when there isn't one. */
          const prevEntry = prevById.get(String(event.id));
          if (prevEntry) {
            byId.set(String(event.id), prevEntry);
            carriedInPlay += 1;
          }
          continue;
        }
        const entry = extractLine(event, dayISO, unmapped);
        if (entry) byId.set(entry.espnId, entry);
        else skippedNoLine += 1;
      }
    } catch (err) {
      failedDays += 1;
      console.error(`Scoreboard fetch failed for ${dayISO}: ${err.message}`);
    }
    if (t < LAST_DAY) await sleep(DAY_DELAY_MS);
  }

  console.log(`Carried forward ${carriedInPlay} in-play line(s) from the previous odds.json.`);
  if (unmapped.size) {
    console.log(`Unmapped team names (kept as canon form): ${[...unmapped].join(", ")}`);
  }
  if (skippedNoLine) console.log(`Skipped ${skippedNoLine} events with no O/U line.`);
  if (failedDays) console.log(`${failedDays} day fetch(es) failed.`);

  return [...byId.values()].sort(
    (a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      (a.home < b.home ? -1 : a.home > b.home ? 1 : 0)
  );
}

/* ---------------- main ---------------- */

async function main() {
  let prev = null;
  try {
    prev = JSON.parse(await readFile(OUT, "utf8"));
  } catch (_) {}

  /* espnId -> previous line, so in-play events keep their pre-game total. */
  const prevById = new Map();
  if (prev && Array.isArray(prev.lines)) {
    for (const ln of prev.lines) {
      if (ln && ln.espnId != null) prevById.set(String(ln.espnId), ln);
    }
  }

  const fetched = await fetchAllLines(prevById);
  if (!fetched.length) {
    console.log("No odds fetched — leaving existing odds.json untouched.");
    return;
  }

  const provider = fetched[0].provider || "DraftKings";
  const lines = fetched.map(({ provider: _drop, ...line }) => line);

  // Skip writing if nothing meaningful changed (keeps git history clean).
  if (
    prev &&
    prev.provider === provider &&
    JSON.stringify(prev.lines) === JSON.stringify(lines)
  ) {
    console.log(`No changes (${lines.length} lines). Nothing to write.`);
    return;
  }

  const payload = {
    source: "espn-bets",
    provider,
    fetchedAt: new Date().toISOString(),
    matchCount: lines.length,
    lines
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Wrote ${lines.length} O/U lines from ${provider} via ESPN.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exitCode = 0; // never break the cron on a bad run
});
