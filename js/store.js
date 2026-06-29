/* ============================================================
   STORE — single source of truth, persisted to localStorage.

   STATE shape (localStorage key "wc26ko.v4"):
     config     : tunable scoring config (copy of POINTS_CONFIG +
                  GOAL_BONUS_PER_GOAL), editable
     draftOrder : [abbr] — the 12-team knockout draft order (seed)
     pickLog    : [countryId] in the exact order countries were drafted
     results    : { matchId: { ga, gb, winner } } — bracket results,
                  where `winner` is a countryId
     draftVersion : monotonic int — the OWNER-published draft revision.
                  GATES draft adoption (draftOrder/pickLog/draftDirection)
                  INDEPENDENTLY of `updatedAt`. This exists because the live
                  results auto-feed re-stamps `updatedAt` to Date.now() on
                  every score, which used to permanently block a re-published
                  draft (its `updatedAt` is fixed and older). Bump it in
                  data/results.json whenever the draft itself changes.

   Everything else (who owns what, the live bracket, standings) is
   DERIVED via the selectors below, so there is never stale duplicated
   state to keep in sync.

   WINNER CONVENTION (read carefully):
   - INTERNALLY (STATE.results) a winner is stored as a countryId.
   - buildBracket() exposes BOTH:
       match.winnerId  -> the winning countryId  (used by scoring)
       match.winner    -> "home" | "away" | null (blueprint Match
                          shape; used by the bracket renderer)
     Both always agree: winner === "home" iff winnerId === home.countryId.
   ============================================================ */

var STORAGE_KEY = "wc26ko.v4";

function defaultState() {
  return {
    config: {
      points: JSON.parse(JSON.stringify(POINTS_CONFIG)),
      goalBonusPerGoal: GOAL_BONUS_PER_GOAL,
      /* "best-first" = the listed order seeds the snake; flipping on the Draft
         Order tab toggles this to "worst-first" so the Recap label stays honest. */
      draftDirection: "best-first"
    },
    draftOrder: TEAMS.map(function (t) { return t.abbr; }),
    pickLog: [],
    results: {},
    updatedAt: 0,
    draftVersion: 0
  };
}

/* Coerce an arbitrary value to an exact permutation of the 12 known team
   abbrs: drop unknowns/dupes, then append any missing teams in default
   order. If it can't be repaired to the full 12, fall back to default. */
function repairDraftOrder(value) {
  var def = defaultState();
  if (!Array.isArray(value)) return def.draftOrder;
  var seenAbbr = {};
  var cleaned = [];
  value.forEach(function (abbr) {
    if (TEAM_BY_ABBR[abbr] && !seenAbbr[abbr]) {
      seenAbbr[abbr] = true;
      cleaned.push(abbr);
    }
  });
  def.draftOrder.forEach(function (abbr) {
    if (!seenAbbr[abbr]) {
      seenAbbr[abbr] = true;
      cleaned.push(abbr);
    }
  });
  return cleaned.length === def.draftOrder.length ? cleaned : def.draftOrder;
}

/* Filter an arbitrary value to a de-duped list of countryIds that exist
   in COUNTRY_BY_ID. Non-arrays yield []. */
function filterPickLog(value) {
  var pickLog = [];
  if (Array.isArray(value)) {
    var seenId = {};
    value.forEach(function (id) {
      if (COUNTRY_BY_ID[id] && !seenId[id]) {
        seenId[id] = true;
        pickLog.push(id);
      }
    });
  }
  return pickLog;
}

function loadState() {
  try {
    var raw = (typeof localStorage !== "undefined") && localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    var saved = JSON.parse(raw);
    var def = defaultState();
    var cfg = saved.config || {};

    var draftOrder = repairDraftOrder(saved.draftOrder);
    var pickLog = filterPickLog(saved.pickLog);

    return {
      config: {
        points: Object.assign({}, def.config.points, cfg.points || {}),
        goalBonusPerGoal: typeof cfg.goalBonusPerGoal === "number"
          ? cfg.goalBonusPerGoal
          : def.config.goalBonusPerGoal,
        draftDirection: cfg.draftDirection === "worst-first" ? "worst-first" : "best-first"
      },
      draftOrder: draftOrder,
      pickLog: pickLog,
      results: saved.results && typeof saved.results === "object" ? saved.results : {},
      updatedAt: typeof saved.updatedAt === "number" ? saved.updatedAt : 0,
      draftVersion: typeof saved.draftVersion === "number" ? saved.draftVersion : 0
    };
  } catch (e) {
    return defaultState();
  }
}

/* Write state to localStorage exactly as given — no timestamp side effects.
   Used by paths (the live auto-feed) that must NOT advance `updatedAt`, since
   that field gates whether a newer SHARED feed is adopted. Best-effort. */
function persistState(state) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } catch (e) {
    /* private mode / quota — keep working in-memory */
  }
}

function saveState(state) {
  /* A local AUTHORITATIVE edit (draft setup, manual result entry): stamp the
     wall clock so the score-keeper's export reflects its newness, then persist. */
  state.updatedAt = Date.now();
  persistState(state);
}

/* ---------- Shared league feed (data/results.json) ---------- */

/* Merge an authoritative shared feed into local state. The DRAFT and the
   RESULTS are gated SEPARATELY, because they change on totally different
   clocks:

     - DRAFT (draftOrder / pickLog / draftDirection): adopted when the feed's
       `draftVersion` is greater than the device's. The owner bumps
       draftVersion only when re-publishing the draft, so a corrected draft
       ALWAYS lands — even mid-tournament when the live auto-feed has pushed
       the device's `updatedAt` far past the feed's. (Legacy fallback: if the
       feed has no draftVersion, fall back to the old `updatedAt` gate so a
       pre-draftVersion feed still works.)

     - RESULTS: a NON-EMPTY published map is adopted when the feed's
       `updatedAt` is strictly newer; an EMPTY map never wipes local results
       (the live auto-feed owns them). The auto-feed no longer advances
       `updatedAt` (see persistState), so a member's device keeps the last
       SHARED timestamp and a newer published map is adopted as intended.

   keeps state.config (except the cosmetic draftDirection flag); persists
   without re-stamping. Returns true if anything changed. */
function applyShared(shared) {
  if (!shared || typeof shared !== "object") return false;
  var state = loadState();
  var changed = false;

  var hasVersion = typeof shared.draftVersion === "number";
  var sharedVersion = hasVersion ? shared.draftVersion : 0;
  var draftIsNewer = hasVersion
    ? sharedVersion > (state.draftVersion || 0)
    : (typeof shared.updatedAt === "number" && shared.updatedAt > (state.updatedAt || 0));

  if (draftIsNewer) {
    if (typeof shared.draftOrder !== "undefined") {
      state.draftOrder = repairDraftOrder(shared.draftOrder);
    }
    if (typeof shared.pickLog !== "undefined") {
      state.pickLog = filterPickLog(shared.pickLog);
    }
    /* draftDirection travels with the shared draft so the Recap label reads the
       same on every device (it's cosmetic; only this flag is adopted from config). */
    if (shared.draftDirection === "best-first" || shared.draftDirection === "worst-first") {
      state.config = Object.assign({}, state.config, { draftDirection: shared.draftDirection });
    }
    if (hasVersion) state.draftVersion = sharedVersion;
    changed = true;
  }

  if (typeof shared.updatedAt === "number" && shared.updatedAt > (state.updatedAt || 0)) {
    var sharedResults = (shared.results && typeof shared.results === "object") ? shared.results : {};
    var hasSharedResults = Object.keys(sharedResults).length > 0;
    var hasLocalResults = state.results && typeof state.results === "object" &&
      Object.keys(state.results).length > 0;
    /* An EMPTY published results map must NEVER wipe a device's accumulated
       results — the live auto-feed derives them locally and a member never
       publishes results, so the feed is {} by design. Only a NON-EMPTY
       authoritative map overwrites; a fresh device with nothing local still
       takes {}. This makes the updatedAt value irrelevant to data safety. */
    if (hasSharedResults || !hasLocalResults) {
      state.results = sharedResults;
    }
    state.updatedAt = shared.updatedAt;
    changed = true;
  }

  if (!changed) return false;
  persistState(state); // preserve the shared/local timestamps as-is
  return true;
}

/* Pretty JSON string of the SHARED fields, stamped with the current time,
   suitable to paste into data/results.json. */
function exportState() {
  var state = loadState();
  /* Bump draftVersion on every export so a re-published feed always supersedes
     the prior one on every member's device, regardless of their live-feed
     inflated `updatedAt`. Idempotent for results-only commits — devices simply
     re-adopt the identical draft. */
  return JSON.stringify({
    updatedAt: Date.now(),
    draftVersion: (state.draftVersion || 0) + 1,
    draftOrder: state.draftOrder,
    draftDirection: (state.config && state.config.draftDirection) || "best-first",
    pickLog: state.pickLog,
    results: state.results
  }, null, 2);
}

/* ---------- Live auto-feed (BB2) ---------- */

/* RESULT PRECEDENCE: manual > committed(shared) > auto-feed > empty.
   - MANUAL: app.js owns its result writers (onScoreChange / onBracketClick)
     and stamps results[id].manual = true on every hand entry. The store
     never sets manual:true; it only reads the presence of an entry.
   - COMMITTED/SHARED: applyShared() overwrites the whole results map from
     data/results.json. Those entries (manual flag or not) count as
     "existing" and are never touched by the auto-feed.
   - AUTO-FEED: applyAutoResults() below FILLS empty matches only.

   applyAutoResults(derived): `derived` is the output of
   Live.deriveResults(fixtures) -> { matchId: { winnerId, ga, gb } } for
   FINISHED fixtures with a clear winner. For each matchId, if STATE.results
   already has ANY entry (manual or shared/committed), it is left untouched —
   auto NEVER overrides an existing result. Otherwise the match is filled with
   the current resolved slot ids (from buildBracket) so the B1 stale-goal
   guard keeps working. persistState (no timestamp bump) + returns true iff
   anything changed. */
function applyAutoResults(derived) {
  if (!derived || typeof derived !== "object") return false;

  var state = loadState();
  // Resolve current home/away countryIds per matchId from the live bracket.
  var rounds = buildBracket(state);
  var slotsById = {};
  rounds.forEach(function (round) {
    round.matches.forEach(function (mt) {
      slotsById[mt.id] = { aId: mt.home.countryId, bId: mt.away.countryId };
    });
  });

  var changed = false;
  Object.keys(derived).forEach(function (matchId) {
    // Never overwrite an existing result (manual, shared, or already auto).
    if (state.results[matchId]) return;

    var d = derived[matchId];
    if (!d || !d.winnerId) return;

    var slots = slotsById[matchId];
    if (!slots) return;

    state.results[matchId] = {
      winner: d.winnerId,
      ga: typeof d.ga === "number" ? d.ga : null,
      gb: typeof d.gb === "number" ? d.gb : null,
      aId: slots.aId,
      bId: slots.bId,
      manual: false
    };
    changed = true;
  });

  /* Persist WITHOUT stamping updatedAt: auto-filled live results must not
     advance the timestamp that gates SHARED-feed adoption, or a member's
     device would keep rejecting newer published feeds (the original bug). */
  if (changed) persistState(state);
  return changed;
}

/* ---------- Draft selectors ---------- */

/* The full snake-draft order of team abbrs across all rounds (2 picks
   per team). Snake = order reverses every round, so each team lands
   one earlier (stronger) pick and one later (weaker) pick. Capped at
   the size of the field. */
function pickSequence(state) {
  var base = state.draftOrder.slice();
  var seq = [];
  var rounds = 2; // teamsPerPlayer = 2
  for (var r = 0; r < rounds; r++) {
    var row = r % 2 === 0 ? base : base.slice().reverse();
    seq = seq.concat(row);
  }
  return seq.slice(0, FIELD.length);
}

function totalPicks(state) {
  return pickSequence(state).length;
}

/* Whose pick is on the clock (null once the draft is complete). */
function currentPicker(state) {
  var seq = pickSequence(state);
  return state.pickLog.length < seq.length ? seq[state.pickLog.length] : null;
}

function draftComplete(state) {
  return state.pickLog.length >= totalPicks(state);
}

/* countryId -> owning team abbr (only drafted countries appear). */
function ownersByCountry(state) {
  var seq = pickSequence(state);
  var map = {};
  state.pickLog.forEach(function (countryId, i) {
    map[countryId] = seq[i];
  });
  return map;
}

/* team abbr -> [countryId, …] in draft order. Every team in draftOrder
   gets an (initially empty) array. */
function countriesByTeam(state) {
  var seq = pickSequence(state);
  var map = {};
  state.draftOrder.forEach(function (abbr) { map[abbr] = []; });
  state.pickLog.forEach(function (countryId, i) {
    var abbr = seq[i];
    if (!map[abbr]) map[abbr] = [];
    map[abbr].push(countryId);
  });
  return map;
}

/* The country objects (from FIELD) not yet drafted. */
function availableCountries(state) {
  var taken = {};
  state.pickLog.forEach(function (id) { taken[id] = true; });
  return FIELD.filter(function (c) { return !taken[c.id]; });
}

/* ---------- Bracket selectors ---------- */

/* Resolve a countryId to a {countryId, name, flag, goals} home/away slot.
   goals come from STATE.results for that match side; null if not entered.
   A null countryId yields a TBD slot. */
function slotFor(countryId, goals) {
  var c = countryId ? COUNTRY_BY_ID[countryId] : null;
  return {
    countryId: countryId || null,
    name: c ? c.name : null,
    flag: c ? c.flag : null,
    goals: typeof goals === "number" ? goals : null
  };
}

/* Build every round from the first-round pairs + results map. Later-round
   slots fill in only once both feeder winners exist. A stored winner only
   stands while BOTH teams are still present.

   Returns: [ Round ] where
     Round = { name, label, ordinal, points, matches: [ Match ] }
     Match = {
       id, round,
       home: { countryId, name, flag, goals },
       away: { countryId, name, flag, goals },
       winnerId: countryId|null,      // internal scoring winner
       winner:   "home"|"away"|null,  // blueprint renderer winner
       homeGoals, awayGoals,          // fixture-compat mirrors of *.goals
       status: "SCHEDULED"|"IN_PLAY"|"FINISHED"
     } */
function buildBracket(state) {
  var pairs = firstRoundPairs();
  var rounds = [];

  ROUNDS.forEach(function (meta, ri) {
    var matches = [];
    for (var m = 0; m < meta.matches; m++) {
      var id = matchIdFor(meta.key, m);
      var aId = null;
      var bId = null;
      if (ri === 0) {
        aId = pairs[m] ? pairs[m][0] : null;
        bId = pairs[m] ? pairs[m][1] : null;
      } else {
        var prev = rounds[ri - 1].matches;
        aId = prev[m * 2] ? prev[m * 2].winnerId : null;
        bId = prev[m * 2 + 1] ? prev[m * 2 + 1].winnerId : null;
      }

      var res = state.results[id] || {};
      var ga = typeof res.ga === "number" ? res.ga : null;
      var gb = typeof res.gb === "number" ? res.gb : null;

      // Goal-attribution guard: a stored result is only valid while the
      // match's slots still hold the same countries they did when the
      // result was entered. If aId/bId were recorded (non-legacy) and they
      // no longer match the current resolved slots, drop the stale goals.
      // Missing aId/bId (legacy saved state) -> no change.
      if (typeof res.aId !== "undefined" && typeof res.bId !== "undefined" &&
          (res.aId !== aId || res.bId !== bId)) {
        ga = null;
        gb = null;
      }

      // A stored winner only stands while both teams are present, and (when
      // aId/bId are present) while the slots still match the recorded teams.
      var winnerId = null;
      if (res.winner && (res.winner === aId || res.winner === bId) &&
          !(typeof res.aId !== "undefined" && typeof res.bId !== "undefined" &&
            (res.aId !== aId || res.bId !== bId))) {
        winnerId = res.winner;
      }

      var winner = null;
      if (winnerId) winner = winnerId === aId ? "home" : "away";

      var status = "SCHEDULED";
      if (winnerId) status = "FINISHED";
      else if (ga !== null || gb !== null) status = "IN_PLAY";

      matches.push({
        id: id,
        round: meta.key,
        home: slotFor(aId, ga),
        away: slotFor(bId, gb),
        winnerId: winnerId,
        winner: winner,
        homeGoals: ga,
        awayGoals: gb,
        status: status
      });
    }
    rounds.push({
      name: meta.key,
      label: meta.label,
      ordinal: meta.ordinal,
      points: meta.points,
      matches: matches
    });
  });

  return rounds;
}

/* Stable match id: "r32-1" … "final-1" (round key lowercased, 1-based). */
function matchIdFor(roundKey, index) {
  return String(roundKey).toLowerCase() + "-" + (index + 1);
}

/* The champion's countryId (winner of the Final), or null. */
function champion(state) {
  var rounds = buildBracket(state);
  var fin = rounds[rounds.length - 1].matches[0];
  return fin ? fin.winnerId : null;
}

/* ---------- Scoring ---------- */

/* Per-country scoring breakdown keyed by countryId:
     { advance, goals, goalBonus, total, reached, out, wins }
   - advance  : sum of round points for matches this country won
   - goals    : total goals across its KO matches
   - goalBonus: goals * goalBonusPerGoal
   - total    : advance + goalBonus
   - reached  : furthest round key reached ("R32".."Final"|"Champion"|"—")
   - out      : true once eliminated
   - wins     : [roundKey] this country advanced out of */
function teamScores(state) {
  var rounds = buildBracket(state);
  var points = state.config.points || POINTS_CONFIG;
  var perGoal = typeof state.config.goalBonusPerGoal === "number"
    ? state.config.goalBonusPerGoal
    : GOAL_BONUS_PER_GOAL;

  var scores = {};
  FIELD.forEach(function (c) {
    scores[c.id] = {
      advance: 0, goals: 0, goalBonus: 0, total: 0,
      reached: "—", out: false, wins: []
    };
  });

  var reachedOrdinal = {}; // countryId -> highest round ordinal reached
  rounds.forEach(function (round) {
    round.matches.forEach(function (mt) {
      [["home", "homeGoals"], ["away", "awayGoals"]].forEach(function (side) {
        var cid = mt[side[0]].countryId;
        if (!cid || !scores[cid]) return;
        if (!reachedOrdinal[cid] || round.ordinal > reachedOrdinal[cid]) {
          reachedOrdinal[cid] = round.ordinal;
        }
        var g = mt[side[1]];
        if (typeof g === "number") scores[cid].goals += g;
      });

      if (mt.winnerId && scores[mt.winnerId]) {
        scores[mt.winnerId].advance += round.points || 0;
        scores[mt.winnerId].wins.push(round.name);
      }
      // Mark the loser eliminated.
      if (mt.winnerId) {
        var loserId = mt.winnerId === mt.home.countryId
          ? mt.away.countryId
          : mt.home.countryId;
        if (loserId && scores[loserId]) scores[loserId].out = true;
      }
    });
  });

  var championId = champion(state);

  FIELD.forEach(function (c) {
    var s = scores[c.id];
    var ord = reachedOrdinal[c.id];
    if (championId && c.id === championId) {
      s.reached = "Champion";
    } else if (ord) {
      var meta = ROUNDS[ord - 1];
      s.reached = meta ? meta.key : "—";
    } else {
      s.reached = "—";
    }
    s.goalBonus = s.goals * perGoal;
    s.total = s.advance + s.goalBonus;
  });

  return scores;
}

/* ---------- Standings ---------- */

/* roundOrdinal(roundKey) -> 1..5 (or 0 if unknown). Used for `reached`.
   ROUNDS items are keyed by `key` (data.js), so match on that. */
function roundOrdinal(roundKey) {
  for (var i = 0; i < ROUNDS.length; i++) {
    if (ROUNDS[i].key === roundKey) return ROUNDS[i].ordinal;
  }
  return 0;
}

/* League standings as blueprint StandingsRow[].

   StandingsRow = {
     team,           // the 12-team object (TEAM_BY_ABBR[abbr])
     rank,           // 1..12, by points desc (draft slot pre-draft)
     tied,           // bool — shares (points, advancePoints) with a neighbor
     points,         // PRIMARY SORT = advancePoints + goalBonus
     advancePoints,  // sum of round points for this team's countries' wins
     goals,          // total goals by this team's drafted countries
     goalBonus,      // goals * goalBonusPerGoal
     drafted,        // [country, country] resolved objects (may be < 2 / [])
     wins,           // count of round-advances across both countries
     reached,        // furthest round any country reached ("R32".."Champion"|"—")
     aliveCount      // 0,1,2 — countries still in the bracket
   }

   Sorted by points desc, tiebreak advancePoints desc, then draft order.
   Pre-draft (draft incomplete): rows in draft.order order, all zero,
   drafted [], reached "—", aliveCount 0. */
function standings(state) {
  var byTeam = countriesByTeam(state);
  var tScores = teamScores(state);
  var complete = draftComplete(state);

  var orderIndex = {};
  state.draftOrder.forEach(function (abbr, i) { orderIndex[abbr] = i; });

  var rows = state.draftOrder.map(function (abbr) {
    var ids = byTeam[abbr] || [];
    var advancePoints = 0;
    var goals = 0;
    var goalBonus = 0;
    var wins = 0;
    var aliveCount = 0;
    var bestOrdinal = 0;
    var reached = "—";
    var drafted = [];

    ids.forEach(function (id) {
      var c = COUNTRY_BY_ID[id];
      if (c) drafted.push(c);
      var s = tScores[id];
      if (!s) return;
      advancePoints += s.advance;
      goals += s.goals;
      goalBonus += s.goalBonus;
      wins += s.wins.length;
      if (!s.out) aliveCount += 1;
      if (s.reached === "Champion") {
        bestOrdinal = Math.max(bestOrdinal, ROUNDS.length + 1);
        reached = "Champion";
      } else {
        var ord = roundOrdinal(s.reached);
        if (ord > bestOrdinal) { bestOrdinal = ord; reached = s.reached; }
      }
    });

    return {
      team: TEAM_BY_ABBR[abbr] || { abbr: abbr, name: abbr },
      rank: 0,
      tied: false,
      points: advancePoints + goalBonus,
      advancePoints: advancePoints,
      goals: goals,
      goalBonus: goalBonus,
      drafted: complete ? drafted : [],
      wins: wins,
      reached: complete ? reached : "—",
      aliveCount: complete ? aliveCount : 0,
      _abbr: abbr
    };
  });

  if (!complete) {
    // Pre-draft: keep draft.order, everything zeroed.
    rows.forEach(function (row, i) {
      row.points = 0;
      row.advancePoints = 0;
      row.goals = 0;
      row.goalBonus = 0;
      row.wins = 0;
      row.rank = i + 1;
      row.tied = false;
    });
    rows.forEach(function (row) { delete row._abbr; });
    return rows;
  }

  rows.sort(function (x, y) {
    if (y.points !== x.points) return y.points - x.points;
    if (y.advancePoints !== x.advancePoints) return y.advancePoints - x.advancePoints;
    return orderIndex[x._abbr] - orderIndex[y._abbr];
  });

  // Rank with shared-rank ties on (points, advancePoints).
  var rank = 0;
  var lastKey = null;
  rows.forEach(function (row, i) {
    var key = row.points + "|" + row.advancePoints;
    if (key !== lastKey) { rank = i + 1; lastKey = key; }
    row.rank = rank;
  });

  // Flag tied rows (adjacent identical key).
  rows.forEach(function (row, i) {
    var key = row.points + "|" + row.advancePoints;
    var prev = i > 0 ? rows[i - 1] : null;
    var next = i < rows.length - 1 ? rows[i + 1] : null;
    var prevKey = prev ? prev.points + "|" + prev.advancePoints : null;
    var nextKey = next ? next.points + "|" + next.advancePoints : null;
    row.tied = key === prevKey || key === nextKey;
  });

  rows.forEach(function (row) { delete row._abbr; });
  return rows;
}
