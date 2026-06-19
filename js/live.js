/* ============================================================
   Live layer — KNOCKOUT, kept dormant-compatible.

   The R32 field has no live data until the tournament's knockout
   stage starts AND the draft completes. So:
     - applyMatches / applyCards / applyFouls are NO-OPS while the
       draft is incomplete (no pre-draft data maps to a bracket).
       Once the draft completes they may overlay goals/cards/fouls
       onto FIELD countries (and bracket goals, if a sink is wired).
     - load() returns a well-formed (possibly empty/null) payload so
       app.js never crashes.
     - resolveCountry() searches FIELD (not GROUPS).
     - attachToFixtures() matches on fx.round (was fx.group).

   The public API surface (INPLAY, FINISHED, isCounted, calendarUrl,
   highlightsUrl, googleMatchUrl) is preserved EXACTLY — app.js's
   statusInfo() and the schedule/matchcenter links depend on it.
   ============================================================ */

var Live = (function () {
  "use strict";

  /* Normalize a country name for fuzzy matching API names to seed names. */
  function norm(s) {
    return String(s)
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents
      .replace(/&/g, " and ")
      .replace(/[^a-z]+/g, " ")
      .trim();
  }

  var ALIASES = {
    "turkey": "türkiye",
    "cote d ivoire": "ivory coast",
    "cabo verde": "cape verde",
    "congo dr": "dr congo",
    "dr congo": "dr congo",
    "democratic republic of the congo": "dr congo",
    "islamic republic of iran": "iran",
    "ir iran": "iran",
    "united states of america": "united states",
    "usa": "united states",
    "czechia": "czech republic",
    "bosnia and herzegovina": "bosnia and herzegovina",
    "korea republic": "south korea"
  };

  /* Map an API team name to a FIELD country object (or null). */
  function resolveCountry(apiName) {
    var n = norm(apiName);
    if (ALIASES[n]) n = norm(ALIASES[n]);
    var found = null;
    if (typeof FIELD !== "undefined") {
      FIELD.forEach(function (c) {
        if (norm(c.name) === n) found = c;
      });
    }
    return found;
  }

  var FINISHED = { FINISHED: 1, AWARDED: 1 };
  var INPLAY = { IN_PLAY: 1, PAUSED: 1, LIVE: 1, HALFTIME: 1 };

  function isCounted(status) { return FINISHED[status] || INPLAY[status]; }

  /* Whether the draft is complete; mutations are no-ops until it is. */
  function draftReady() {
    try {
      if (typeof loadState === "function" && typeof draftComplete === "function") {
        return draftComplete(loadState());
      }
    } catch (e) { /* fall through */ }
    return false;
  }

  /* Overlay goals from live matches onto FIELD countries. No-op while the
     draft is incomplete. Resets FIELD goals to 0 before summing. */
  function applyMatches(matches) {
    if (!draftReady()) return false;
    if (!matches || !matches.length) return false;
    if (typeof FIELD === "undefined") return false;

    FIELD.forEach(function (c) { c.goals = 0; });

    matches.forEach(function (m) {
      if (!isCounted(m.status)) return;
      if (m.homeGoals == null || m.awayGoals == null) return;
      var h = resolveCountry(m.home);
      var a = resolveCountry(m.away);
      if (h) h.goals += m.homeGoals;
      if (a) a.goals += m.awayGoals;
    });

    return true;
  }

  /* Overlay card counts onto FIELD (display only). No-op pre-draft. */
  function applyCards(byCountry) {
    if (!draftReady()) return false;
    if (!byCountry || !Object.keys(byCountry).length) return false;
    if (typeof FIELD === "undefined") return false;

    FIELD.forEach(function (c) { c.yellows = 0; c.reds = 0; });

    Object.keys(byCountry).forEach(function (name) {
      var c = resolveCountry(name);
      if (!c) return;
      c.yellows += byCountry[name].y || 0;
      c.reds += byCountry[name].r || 0;
    });

    return true;
  }

  /* Overlay foul counts onto FIELD (display only). No-op pre-draft. */
  function applyFouls(byCountry) {
    if (!draftReady()) return false;
    if (!byCountry || !Object.keys(byCountry).length) return false;
    if (typeof FIELD === "undefined") return false;

    FIELD.forEach(function (c) { c.fouls = 0; });

    Object.keys(byCountry).forEach(function (name) {
      var c = resolveCountry(name);
      if (!c) return;
      c.fouls += byCountry[name].f || 0;
    });

    return true;
  }

  /* BB2 (feed half): derive auto-results from FINISHED fixtures with a clear
     winner. Pure read-only — builds { matchId: { winnerId, ga, gb } } for each
     fixture whose status is in FINISHED and whose homeGoals/awayGoals are both
     numbers AND not equal. Skips TBD slots, equal scores (manual shootout call),
     and non-finished matches. Returns {} when nothing qualifies. The caller
     (store.applyAutoResults) decides precedence; this never writes anywhere. */
  function deriveResults(fixtures) {
    var out = {};
    if (!fixtures || !fixtures.length) return out;

    fixtures.forEach(function (fx) {
      if (!fx || fx.id == null) return;
      if (!FINISHED[fx.status]) return;

      var ga = fx.homeGoals;
      var gb = fx.awayGoals;
      if (typeof ga !== "number" || typeof gb !== "number") return;
      if (ga === gb) return; // equal -> leave for manual shootout call

      var winSide = ga > gb ? fx.home : fx.away;
      if (!winSide || winSide.countryId == null) return; // TBD slot, no clear winner

      out[fx.id] = { winnerId: winSide.countryId, ga: ga, gb: gb };
    });

    return out;
  }

  /* Canonicalize an API team name to its normalized FIELD form. */
  function canon(apiName) {
    var c = resolveCountry(apiName);
    if (c) return norm(c.name);
    var n = norm(apiName);
    return ALIASES[n] ? norm(ALIASES[n]) : n;
  }

  /* Match an API match to a generated fixture by ROUND + the unordered
     pair of teams, then copy status/score/time (and per-match card
     counts, when cardsByMatch is given) onto the fixture in ITS
     orientation. Matches on fx.round (was fx.group). */
  function attachToFixtures(fixtures, matches, cardsByMatch) {
    if (!matches || !matches.length) return 0;
    var attached = 0;

    fixtures.forEach(function (fx) {
      if (!fx.home || !fx.away || !fx.home.name || !fx.away.name) return;
      var fxHome = norm(fx.home.name);
      var fxAway = norm(fx.away.name);

      var hit = matches.find(function (m) {
        if (m.round !== fx.round) return false;
        var mh = canon(m.home);
        var ma = canon(m.away);
        return (mh === fxHome && ma === fxAway) || (mh === fxAway && ma === fxHome);
      });
      if (!hit) return;

      attached += 1;
      fx.matchId = hit.id != null ? String(hit.id) : fx.matchId; // feed id — keys data/recaps.json
      fx.status = hit.status || fx.status;
      fx.utcDate = hit.utcDate || fx.utcDate;
      fx.venue = hit.venue || fx.venue;
      fx.minute = hit.minute || fx.minute;

      var sameOrientation = canon(hit.home) === fxHome;
      if (hit.homeGoals != null && hit.awayGoals != null) {
        fx.homeGoals = sameOrientation ? hit.homeGoals : hit.awayGoals;
        fx.awayGoals = sameOrientation ? hit.awayGoals : hit.homeGoals;
      }

      var perMatch = cardsByMatch && hit.id != null && cardsByMatch[hit.id];
      if (perMatch) {
        var home = { y: 0, r: 0 };
        var away = { y: 0, r: 0 };
        Object.keys(perMatch).forEach(function (name) {
          var n = canon(name);
          if (n === fxHome) home = perMatch[name];
          else if (n === fxAway) away = perMatch[name];
        });
        fx.cards = { home: home, away: away };
      }
    });

    return attached;
  }

  /* Load data/live.json. Returns a well-formed payload or null so app.js
     never crashes. Pre-draft this still resolves (the mutators are the
     no-ops), so callers can poll harmlessly. */
  function load() {
    if (typeof fetch !== "function") return Promise.resolve(null);
    return fetch("data/live.json?v=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (data) {
        try {
          return (typeof window !== "undefined" && window.LiveDirect)
            ? LiveDirect.overlay(data)
            : data;
        } catch (err) {
          return data;
        }
      });
  }

  /* YouTube highlights search for a fixture — always works, no API key. */
  function highlightsUrl(home, away) {
    var q = home + " vs " + away + " World Cup 2026 highlights";
    return "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
  }

  /* Google match page for a fixture — the plain "A vs B" search. */
  function googleMatchUrl(home, away) {
    return "https://www.google.com/search?q=" + encodeURIComponent(home + " vs " + away);
  }

  /* Google Calendar "add event" link for a fixture kickoff (110-min block).
     The third arg is the round label (was the group letter); accepted as a
     free-form descriptor so existing callers keep working. */
  function calendarUrl(home, away, round, utcDate) {
    if (!utcDate) return null;
    var start = new Date(utcDate);
    if (isNaN(start)) return null;
    var end = new Date(start.getTime() + 110 * 60000);
    var fmt = function (d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); };
    var label = round ? (" (" + round + ")") : "";
    var params =
      "action=TEMPLATE" +
      "&text=" + encodeURIComponent(home + " vs " + away + label) +
      "&dates=" + fmt(start) + "/" + fmt(end) +
      "&details=" + encodeURIComponent("2026 FIFA World Cup" + (round ? (" · " + round) : ""));
    return "https://www.google.com/calendar/render?" + params;
  }

  return {
    load: load,
    applyMatches: applyMatches,
    applyCards: applyCards,
    applyFouls: applyFouls,
    attachToFixtures: attachToFixtures,
    deriveResults: deriveResults,
    resolveCountry: resolveCountry,
    isCounted: isCounted,
    FINISHED: FINISHED,
    INPLAY: INPLAY,
    highlightsUrl: highlightsUrl,
    googleMatchUrl: googleMatchUrl,
    calendarUrl: calendarUrl
  };
})();
