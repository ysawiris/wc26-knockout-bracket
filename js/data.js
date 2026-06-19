/* ============================================================
   LEAGUE DATA — knockout-stage seed + config.

   "The Longest Yard" snake-drafts 2 of the 32 Round-of-32
   countries to each of its 12 teams. Rank = sum of knockout
   advancement points (R32=3, R16=5, QF=8, SF=13, Final=21)
   plus a small per-goal bonus. Cards/fouls are DISPLAY ONLY
   and never affect scoring.

   Goals normally update themselves: a GitHub Action pulls a
   live feed into data/live.json, which overlays onto FIELD.
   Manual edits to a country's `goals` only take effect when
   the live feed is down. The draft is a GATE — the hub stays
   locked until all 24 picks are in.
   ============================================================ */

var LEAGUE = {
  name: "The Longest Yard",
  season: "2026 FIFA World Cup — Knockout Pool",
  lastUpdated: "June 18, 2026",
  drawNote:
    "12-team knockout pool. Each team snake-drafts 2 of the 32 Round-of-32 " +
    "countries — one stronger, one weaker. Score by how far your countries " +
    "advance (R32 3 / R16 5 / QF 8 / SF 13 / Final 21) plus 0.1 per goal. " +
    "Cards and fouls are shown but never count. The hub unlocks once all " +
    "24 picks are drafted."
};

/* The 12 teams in "The Longest Yard" league, listed in last-season
   final-standings order (the default draft-order seed). `record` is
   last season's W-L-T; `accent` colors the crest. `managers` may be
   empty — the board falls back to the record. `isMine` is set at
   runtime by js/my-team.js. NO group field (knockout has no groups). */
var TEAMS = [
  { abbr: "B2B",  name: "Back 2 Back Brax Attack", managers: [], accent: "#c8a24a", record: "10-4-0" },
  { abbr: "S&B",  name: "Screws & Brews",          managers: [], accent: "#e07b16", record: "7-7-0"  },
  { abbr: "SAM",  name: "Sam Mease's Neat Team",   managers: [], accent: "#2e7d32", record: "12-2-0" },
  { abbr: "DEF",  name: "Dr. of De Feet",          managers: [], accent: "#1f6fb0", record: "9-5-0"  },
  { abbr: "FSLP", name: "First State Last Place",  managers: [], accent: "#5b3fa0", record: "7-7-0"  },
  { abbr: "YPMG", name: "Your pain my gain",       managers: [], accent: "#0e8aa0", record: "7-7-0"  },
  { abbr: "JCT",  name: "Joseph's Choice Team",    managers: [], accent: "#c0392b", record: "7-7-0"  },
  { abbr: "DEMI", name: "Demi's Second To None",   managers: [], accent: "#455a64", record: "3-11-0" },
  { abbr: "GG",   name: "Glazier's Goodies",       managers: [], accent: "#7e8a97", record: "7-7-0"  },
  { abbr: "ZTW",  name: "Z's Tighty Whiteys",      managers: [], accent: "#7d8c2b", record: "5-9-0"  },
  { abbr: "GOFF", name: "Jerking Goff",            managers: [], accent: "#6d4c41", record: "4-10-0" },
  { abbr: "SST",  name: "Seth's Splendid Team",    managers: [], accent: "#d6336c", record: "6-8-0"  }
];

/* The 32 Round-of-32 countries, ordered by a strength seed (1 =
   strongest). `seed` drives both bracket pairing (1v32, 2v31, …) and
   the strong/weak split in the snake draft. c1/c2 are the gradient
   colors of each country's bar (c2 mirrors c1 where the source had
   only one). goals/yellows/reds/fouls start at 0 and may be overlaid
   from the live feed. Cards/fouls are display-only (never scored). */
var FIELD = [
  { id: "ARG", name: "Argentina",     flag: "🇦🇷", seed: 1,  c1: "#4a92d0", c2: "#4a92d0", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "FRA", name: "France",        flag: "🇫🇷", seed: 2,  c1: "#1f3c9e", c2: "#1f3c9e", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "ESP", name: "Spain",         flag: "🇪🇸", seed: 3,  c1: "#c60b1e", c2: "#c60b1e", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "ENG", name: "England",       flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", seed: 4,  c1: "#c8102e", c2: "#c8102e", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "BRA", name: "Brazil",        flag: "🇧🇷", seed: 5,  c1: "#009739", c2: "#009739", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "POR", name: "Portugal",      flag: "🇵🇹", seed: 6,  c1: "#a3122a", c2: "#a3122a", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "NED", name: "Netherlands",   flag: "🇳🇱", seed: 7,  c1: "#f36c21", c2: "#f36c21", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "GER", name: "Germany",       flag: "🇩🇪", seed: 8,  c1: "#3a3a3a", c2: "#3a3a3a", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "BEL", name: "Belgium",       flag: "🇧🇪", seed: 9,  c1: "#5b5651", c2: "#5b5651", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "CRO", name: "Croatia",       flag: "🇭🇷", seed: 10, c1: "#d12127", c2: "#d12127", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "URU", name: "Uruguay",       flag: "🇺🇾", seed: 11, c1: "#3f87bd", c2: "#3f87bd", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "COL", name: "Colombia",      flag: "🇨🇴", seed: 12, c1: "#caa10a", c2: "#caa10a", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "MAR", name: "Morocco",       flag: "🇲🇦", seed: 13, c1: "#c1272d", c2: "#c1272d", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "USA", name: "United States", flag: "🇺🇸", seed: 14, c1: "#2b4ea0", c2: "#2b4ea0", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "MEX", name: "Mexico",        flag: "🇲🇽", seed: 15, c1: "#006847", c2: "#006847", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "JPN", name: "Japan",         flag: "🇯🇵", seed: 16, c1: "#bc002d", c2: "#bc002d", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "SUI", name: "Switzerland",   flag: "🇨🇭", seed: 17, c1: "#da291c", c2: "#da291c", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "SEN", name: "Senegal",       flag: "🇸🇳", seed: 18, c1: "#00853f", c2: "#00853f", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "ECU", name: "Ecuador",       flag: "🇪🇨", seed: 19, c1: "#d4a017", c2: "#d4a017", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "CIV", name: "Ivory Coast",   flag: "🇨🇮", seed: 20, c1: "#f77f00", c2: "#f77f00", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "SWE", name: "Sweden",        flag: "🇸🇪", seed: 21, c1: "#006aa7", c2: "#006aa7", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "AUS", name: "Australia",     flag: "🇦🇺", seed: 22, c1: "#cf9400", c2: "#cf9400", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "KOR", name: "South Korea",   flag: "🇰🇷", seed: 23, c1: "#cd2e3a", c2: "#cd2e3a", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "CAN", name: "Canada",        flag: "🇨🇦", seed: 24, c1: "#c8102e", c2: "#c8102e", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "EGY", name: "Egypt",         flag: "🇪🇬", seed: 25, c1: "#ce1126", c2: "#ce1126", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "GHA", name: "Ghana",         flag: "🇬🇭", seed: 26, c1: "#006b3f", c2: "#006b3f", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "AUT", name: "Austria",       flag: "🇦🇹", seed: 27, c1: "#ed2939", c2: "#ed2939", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "NOR", name: "Norway",        flag: "🇳🇴", seed: 28, c1: "#ba0c2f", c2: "#ba0c2f", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "TUR", name: "Türkiye",       flag: "🇹🇷", seed: 29, c1: "#e30a17", c2: "#e30a17", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "PAR", name: "Paraguay",      flag: "🇵🇾", seed: 30, c1: "#d52b1e", c2: "#d52b1e", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "IRN", name: "Iran",          flag: "🇮🇷", seed: 31, c1: "#239f40", c2: "#239f40", goals: 0, yellows: 0, reds: 0, fouls: 0 },
  { id: "PAN", name: "Panama",        flag: "🇵🇦", seed: 32, c1: "#005293", c2: "#005293", goals: 0, yellows: 0, reds: 0, fouls: 0 }
];

/* ------------------------------------------------------------
   REAL DRAWN ROUND-OF-32 MATCHUPS (optional override).

   Default null → the bracket falls back to the seed-based
   serpentine pairing (seedSlots/firstRoundPairs: 1v32, 2v31, …).

   To wire the ACTUAL drawn Round of 32, you ONLY edit this one
   array. Fill it with 16 [homeCountryId, awayCountryId] pairs —
   country ids from FIELD — in bracket order r32-1 .. r32-16
   (top of bracket to bottom). When non-null, this replaces the
   serpentine pairing entirely. Example shape:

     var R32_PAIRINGS = [
       ["ARG", "PAN"],   // r32-1
       ["NED", "JPN"],   // r32-2
       ...               // 14 more, 16 pairs total
       ["FRA", "IRN"]    // r32-16
     ];

   Do NOT change FIELD/TEAMS/etc. to wire the draw — just this array. */
var R32_PAIRINGS = null;

/* ------------------------------------------------------------
   HISTORICAL SOURCE DATA — NOT SCORED.

   The original 12 group-stage groups (A–L) of the 2026 World Cup.
   Retained verbatim purely as the authored source of country
   names/colors and to keep data/recaps.json + alias matching
   working. Knockout scoring NEVER reads GROUPS — it reads FIELD.
   Do not delete; do not add scoring off it.
   ------------------------------------------------------------ */
var GROUPS = {
  A: {
    letter: "A",
    countries: [
      { name: "Mexico",         flag: "🇲🇽", c1: "#006847", c2: "#00472f", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "South Africa",   flag: "🇿🇦", c1: "#007749", c2: "#00432a", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "South Korea",    flag: "🇰🇷", c1: "#cd2e3a", c2: "#8e1f28", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Czech Republic", flag: "🇨🇿", c1: "#11457e", c2: "#0b2f57", goals: 0, yellows: 0, reds: 0, fouls: 0 }
    ]
  },
  B: {
    letter: "B",
    countries: [
      { name: "Canada",               flag: "🇨🇦", c1: "#c8102e", c2: "#8f0b21", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Bosnia & Herzegovina", flag: "🇧🇦", c1: "#002f87", c2: "#0a4fc9", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Qatar",                flag: "🇶🇦", c1: "#8a1538", c2: "#5e0e26", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Switzerland",          flag: "🇨🇭", c1: "#da291c", c2: "#9e1c12", goals: 0, yellows: 0, reds: 0, fouls: 0 }
    ]
  },
  C: {
    letter: "C",
    countries: [
      { name: "Brazil",   flag: "🇧🇷", c1: "#009739", c2: "#006227", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Morocco",  flag: "🇲🇦", c1: "#c1272d", c2: "#7a1419", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Haiti",    flag: "🇭🇹", c1: "#00209f", c2: "#001a70", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Scotland", flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", c1: "#003078", c2: "#001f4d", goals: 0, yellows: 0, reds: 0, fouls: 0 }
    ]
  },
  D: {
    letter: "D",
    countries: [
      { name: "United States", flag: "🇺🇸", c1: "#2b4ea0", c2: "#b22234", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Paraguay",      flag: "🇵🇾", c1: "#d52b1e", c2: "#0038a8", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Australia",     flag: "🇦🇺", c1: "#cf9400", c2: "#00843d", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Türkiye",       flag: "🇹🇷", c1: "#e30a17", c2: "#9e0710", goals: 0, yellows: 0, reds: 0, fouls: 0 }
    ]
  },
  E: {
    letter: "E",
    countries: [
      { name: "Germany",     flag: "🇩🇪", c1: "#3a3a3a", c2: "#111111", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Curaçao",     flag: "🇨🇼", c1: "#002b7f", c2: "#00204f", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Ivory Coast", flag: "🇨🇮", c1: "#f77f00", c2: "#c95e00", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Ecuador",     flag: "🇪🇨", c1: "#d4a017", c2: "#8c6900", goals: 0, yellows: 0, reds: 0, fouls: 0 }
    ]
  },
  F: {
    letter: "F",
    countries: [
      { name: "Netherlands", flag: "🇳🇱", c1: "#f36c21", c2: "#b84a0d", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Japan",       flag: "🇯🇵", c1: "#bc002d", c2: "#7a001e", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Sweden",      flag: "🇸🇪", c1: "#006aa7", c2: "#004b76", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Tunisia",     flag: "🇹🇳", c1: "#e70013", c2: "#9c000d", goals: 0, yellows: 0, reds: 0, fouls: 0 }
    ]
  },
  G: {
    letter: "G",
    countries: [
      { name: "Belgium",     flag: "🇧🇪", c1: "#5b5651", c2: "#2a2724", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Egypt",       flag: "🇪🇬", c1: "#ce1126", c2: "#8c0b1a", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Iran",        flag: "🇮🇷", c1: "#239f40", c2: "#136127", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "New Zealand", flag: "🇳🇿", c1: "#00247d", c2: "#001647", goals: 0, yellows: 0, reds: 0, fouls: 0 }
    ]
  },
  H: {
    letter: "H",
    countries: [
      { name: "Spain",        flag: "🇪🇸", c1: "#c60b1e", c2: "#9a0816", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Cape Verde",   flag: "🇨🇻", c1: "#003893", c2: "#5b92e5", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Saudi Arabia", flag: "🇸🇦", c1: "#006c35", c2: "#004d24", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Uruguay",      flag: "🇺🇾", c1: "#3f87bd", c2: "#28628f", goals: 0, yellows: 0, reds: 0, fouls: 0 }
    ]
  },
  I: {
    letter: "I",
    countries: [
      { name: "France",  flag: "🇫🇷", c1: "#1f3c9e", c2: "#0c1f63", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Senegal", flag: "🇸🇳", c1: "#00853f", c2: "#005226", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Iraq",    flag: "🇮🇶", c1: "#a31621", c2: "#4d0a10", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Norway",  flag: "🇳🇴", c1: "#ba0c2f", c2: "#00205b", goals: 0, yellows: 0, reds: 0, fouls: 0 }
    ]
  },
  J: {
    letter: "J",
    countries: [
      { name: "Argentina", flag: "🇦🇷", c1: "#4a92d0", c2: "#2f6ea3", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Algeria",   flag: "🇩🇿", c1: "#006233", c2: "#003d1f", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Austria",   flag: "🇦🇹", c1: "#ed2939", c2: "#a31621", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Jordan",    flag: "🇯🇴", c1: "#007a3d", c2: "#00471f", goals: 0, yellows: 0, reds: 0, fouls: 0 }
    ]
  },
  K: {
    letter: "K",
    countries: [
      { name: "Portugal",   flag: "🇵🇹", c1: "#a3122a", c2: "#046a38", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "DR Congo",   flag: "🇨🇩", c1: "#007fff", c2: "#0050a0", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Uzbekistan", flag: "🇺🇿", c1: "#0099b5", c2: "#006478", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Colombia",   flag: "🇨🇴", c1: "#caa10a", c2: "#946f00", goals: 0, yellows: 0, reds: 0, fouls: 0 }
    ]
  },
  L: {
    letter: "L",
    countries: [
      { name: "England", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", c1: "#c8102e", c2: "#8a0b1f", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Croatia", flag: "🇭🇷", c1: "#d12127", c2: "#16387f", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Ghana",   flag: "🇬🇭", c1: "#006b3f", c2: "#003d23", goals: 0, yellows: 0, reds: 0, fouls: 0 },
      { name: "Panama",  flag: "🇵🇦", c1: "#005293", c2: "#d21034", goals: 0, yellows: 0, reds: 0, fouls: 0 }
    ]
  }
};

/* ------------------------------------------------------------
   SCORING CONFIG — single source of truth.

   POINTS_CONFIG: points for WINNING a match in that round (i.e.
   for advancing OUT of it). Reconciled with the backup KO_CONFIG
   (its "F" key is normalized to "Final" here). GOAL_BONUS_PER_GOAL
   is applied to every goal a team's drafted countries score.
   Every scoring module imports these — never re-hardcode them.
   ------------------------------------------------------------ */
var POINTS_CONFIG = { R32: 3, R16: 5, QF: 8, SF: 13, Final: 21 };
var GOAL_BONUS_PER_GOAL = 0.1;

/* Round metadata, biggest field first.
   key | label | ordinal (1..5) | points | matches in that round. */
var ROUNDS = [
  { key: "R32",   label: "Round of 32", ordinal: 1, points: POINTS_CONFIG.R32,   matches: 16 },
  { key: "R16",   label: "Round of 16", ordinal: 2, points: POINTS_CONFIG.R16,   matches: 8  },
  { key: "QF",    label: "Quarterfinal", ordinal: 3, points: POINTS_CONFIG.QF,    matches: 4  },
  { key: "SF",    label: "Semifinal",   ordinal: 4, points: POINTS_CONFIG.SF,    matches: 2  },
  { key: "Final", label: "Final",       ordinal: 5, points: POINTS_CONFIG.Final, matches: 1  }
];

/* Standard single-elimination seed order for N slots, so the bracket
   pairs 1v32, 2v31, … in proper bracket position (top seeds can only
   meet in the final). Returns a flat list of seeds; pair consecutive
   entries for round 1. */
function seedSlots(n) {
  var slots = [1, 2];
  while (slots.length < n) {
    var sum = slots.length * 2 + 1;
    var next = [];
    for (var i = 0; i < slots.length; i++) {
      next.push(slots[i]);
      next.push(sum - slots[i]);
    }
    slots = next;
  }
  return slots;
}

/* The 16 first-round pairings as [countryId, countryId], in bracket
   order, derived from the seed list above. A slot is null when no
   country carries that seed (only happens if FIELD is short). */
function firstRoundPairs() {
  /* BB6: when the REAL Round-of-32 draw is wired into R32_PAIRINGS (16 valid
     [homeId, awayId] pairs), it takes precedence over the seed serpentine. */
  if (R32_PAIRINGS && R32_PAIRINGS.length === FIELD.length / 2) {
    var ok = R32_PAIRINGS.every(function (p) {
      return p && p.length === 2 &&
        (p[0] == null || COUNTRY_BY_ID[p[0]]) &&
        (p[1] == null || COUNTRY_BY_ID[p[1]]);
    });
    if (ok) return R32_PAIRINGS.map(function (p) { return [p[0], p[1]]; });
  }
  var bySeed = {};
  FIELD.forEach(function (t) { bySeed[t.seed] = t; });
  var order = seedSlots(FIELD.length);
  var pairs = [];
  for (var i = 0; i < order.length; i += 2) {
    var a = bySeed[order[i]];
    var b = bySeed[order[i + 1]];
    pairs.push([a ? a.id : null, b ? b.id : null]);
  }
  return pairs;
}

/* ---------- Lookup maps ---------- */

var TEAM_BY_ABBR = {};
TEAMS.forEach(function (t) { TEAM_BY_ABBR[t.abbr] = t; });

var COUNTRY_BY_ID = {};
FIELD.forEach(function (c) { COUNTRY_BY_ID[c.id] = c; });
