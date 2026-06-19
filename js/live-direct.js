/* Direct-from-FIFA live layer (knockout bracket).

   The cron-committed data/live.json is the durable baseline (~10-min
   cadence, works while nobody has the site open). During match windows
   each open browser ALSO polls FIFA's public API directly (CORS is
   open), so goals, cards and match minutes land in about a minute
   instead of waiting on cron -> commit -> CDN. Results overlay the
   baseline via LiveDirect.overlay(), called from Live.load().

   Also feeds the ⚽ goal ticker under the live strip from FIFA's
   play-by-play timeline (event Type 0 = goal, 2 = yellow, 3 = red,
   18 = foul). Cards/fouls NEVER score in knockout mode (display only),
   but they still flow through overlay() so the live count doesn't drop
   to zero while a direct fetch is fresh.

   DRAFT GATE: every entry point that polls, schedules or renders is a
   no-op until ctx.draft.complete. Pre-draft the bracket isn't seeded,
   so there's nothing to fetch — we never touch the network or set a
   timer until the snake draft finishes. */

(function () {
  "use strict";

  var BASE = "https://api.fifa.com/api/v3";
  var COMPETITION = "17";
  var SEASON = "285023";
  var CAL_URL = BASE + "/calendar/matches?idCompetition=" + COMPETITION +
    "&idSeason=" + SEASON + "&count=200&language=en";

  var FRESH_MS = 5 * 60000;      // how long a direct fetch outranks the baseline
  var LIVE_POLL = 60000;         // poll cadence while a match is in play
  var SOON_POLL = 120000;        // cadence around kickoff (or if statuses look stale)
  var SOON_BEFORE = 20 * 60000;  // start polling this long before kickoff
  var SOON_AFTER = 2 * 3600000;  // keep polling this long after a non-finished kickoff
  var MAX_EVENTS = 8;

  var state = { matches: null, byMatch: {}, events: [], fetchedAt: 0 };
  var timer = null;
  var inFlight = false;
  var bootstrapped = false;

  /* Draft gate: pre-draft the bracket has no pairings, so nothing to poll. */
  function draftDone(ctx) {
    return !!(ctx && ctx.draft && ctx.draft.complete);
  }

  /* ---------------- FIFA mapping (mirrors scripts/fetch-scores.mjs) ---------------- */

  function loc(arr) { return (arr && arr[0] && arr[0].Description) || null; }

  function statusOf(m) {
    if (m.MatchStatus === 0) return "FINISHED";
    if (m.MatchStatus === 3) return m.Period === 4 ? "PAUSED" : "IN_PLAY";
    return "TIMED";
  }

  /* Knockout stage label off the FIFA StageName (Round of 32 .. Final).
     Scoring never reads this — it's only carried for debugging/overlay. */
  function roundOf(m) {
    return loc(m.StageName) || loc(m.GroupName) || null;
  }

  function mapMatch(m, round) {
    return {
      id: m.IdMatch,
      round: round,
      utcDate: m.Date || null,
      status: statusOf(m),
      home: loc(m.Home && m.Home.TeamName) || "TBD",
      away: loc(m.Away && m.Away.TeamName) || "TBD",
      homeGoals: m.HomeTeamScore == null ? null : m.HomeTeamScore,
      awayGoals: m.AwayTeamScore == null ? null : m.AwayTeamScore,
      venue: loc(m.Stadium && m.Stadium.Name),
      minute: m.MatchTime || null
    };
  }

  function getJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status + " for " + url);
      return r.json();
    });
  }

  /* One timeline call per in-play match: card counts + goal events. */
  function fetchTimeline(raw) {
    var url = BASE + "/timelines/" + COMPETITION + "/" + SEASON + "/" +
      raw.IdStage + "/" + raw.IdMatch + "?language=en";
    var teamName = {};
    if (raw.Home) teamName[raw.Home.IdTeam] = loc(raw.Home.TeamName);
    if (raw.Away) teamName[raw.Away.IdTeam] = loc(raw.Away.TeamName);

    return getJson(url).then(function (data) {
      var counts = {};
      var goals = [];
      ((data && data.Event) || []).forEach(function (e) {
        if (e.Type === 2 || e.Type === 3 || e.Type === 18) {
          var country = teamName[e.IdTeam];
          if (!country) return;
          var c = counts[country] || (counts[country] = { y: 0, r: 0, f: 0 });
          if (e.Type === 2) c.y += 1;
          else if (e.Type === 3) c.r += 1;
          else c.f += 1;
        } else if (e.Type === 0) {
          goals.push({ minute: e.MatchMinute || "", text: loc(e.EventDescription) || "Goal!" });
        }
      });
      return { id: raw.IdMatch, counts: counts, goals: goals };
    });
  }

  function poll() {
    if (inFlight) return Promise.resolve();
    inFlight = true;

    return getJson(CAL_URL).then(function (data) {
      var raw = (data && data.Results) || [];
      var matches = [];
      var liveRaw = [];

      raw.forEach(function (m) {
        // Knockout: take every match FIFA returns (no group filter); the
        // round label is informational only and scoring ignores it.
        var mapped = mapMatch(m, roundOf(m));
        matches.push(mapped);
        if (mapped.status === "IN_PLAY" || mapped.status === "PAUSED") liveRaw.push(m);
      });

      // Timelines for live matches only; a single failure shouldn't sink the rest.
      return Promise.all(liveRaw.map(function (m) {
        return fetchTimeline(m).catch(function (err) {
          console.error("Timeline fetch failed:", err.message);
          return null;
        });
      })).then(function (timelines) {
        var byMatch = {};
        var events = [];
        timelines.forEach(function (tl) {
          if (!tl) return;
          byMatch[tl.id] = tl.counts;
          events = events.concat(tl.goals);
        });
        state = {
          matches: matches,
          byMatch: byMatch,
          events: events.slice(-MAX_EVENTS),
          fetchedAt: Date.now()
        };
      });
    }).catch(function (err) {
      console.error("Direct FIFA poll failed:", err.message);
    }).then(function () { inFlight = false; });
  }

  /* ---------------- overlay (called from Live.load) ---------------- */

  function overlay(base) {
    if (!state.matches || Date.now() - state.fetchedAt > FRESH_MS) return base;

    // Per-match card counts: baseline first, direct wins where it has data.
    var byMatch = {};
    var baseBy = (base && base.cards && base.cards.byMatch) || {};
    Object.keys(baseBy).forEach(function (k) { byMatch[k] = baseBy[k]; });
    Object.keys(state.byMatch).forEach(function (k) { byMatch[k] = state.byMatch[k]; });

    var byCountry = {};
    var foulsByCountry = {};
    Object.keys(byMatch).forEach(function (k) {
      var per = byMatch[k];
      Object.keys(per).forEach(function (name) {
        var agg = byCountry[name] || (byCountry[name] = { y: 0, r: 0 });
        agg.y += per[name].y || 0;
        agg.r += per[name].r || 0;
        if (per[name].f) {
          var fa = foulsByCountry[name] || (foulsByCountry[name] = { f: 0 });
          fa.f += per[name].f;
        }
      });
    });

    return {
      source: "fifa.com · direct",
      competition: (base && base.competition) || "FWC2026",
      fetchedAt: new Date(state.fetchedAt).toISOString(),
      matchCount: state.matches.length,
      matches: state.matches,
      cards: { byMatch: byMatch, byCountry: byCountry },
      fouls: { byCountry: foulsByCountry }
    };
  }

  /* ---------------- adaptive scheduling ---------------- */

  function nextDelay(ctx) {
    // Draft incomplete: bracket isn't live yet, so never poll.
    if (!draftDone(ctx)) return 0;

    // Poll cadence keys off every bracket fixture (all rounds), so we tighten
    // up around any live match or imminent kickoff.
    var fixtures = ctx.allFixtures || ctx.fixtures || [];
    var anyLive = fixtures.some(function (fx) { return Live.INPLAY[fx.status]; });
    if (anyLive) return LIVE_POLL;

    // Around kickoff — including "kicked off but the baseline still says
    // TIMED" (stale cron), so we keep checking until FIFA flips it live.
    var now = Date.now();
    var nearKickoff = fixtures.some(function (fx) {
      if (Live.FINISHED[fx.status]) return false;
      var dt = ctx.helpers.fxDate(fx).getTime() - now;
      return dt < SOON_BEFORE && dt > -SOON_AFTER;
    });
    return nearKickoff ? SOON_POLL : 0;
  }

  function schedule(ctx) {
    if (timer) { clearTimeout(timer); timer = null; }
    // Hard gate: no timers at all until the draft completes.
    if (!draftDone(ctx)) return;

    var delay = nextDelay(ctx);
    if (!delay) return;

    // Entering a match window with no direct data yet: fetch right away.
    if (!bootstrapped && !state.fetchedAt) {
      bootstrapped = true;
      delay = 1500;
    }

    timer = setTimeout(function () {
      poll().then(function () { if (window.Hub) Hub.refresh(); });
    }, delay);
  }

  /* ---------------- goal ticker ---------------- */

  function renderTicker(ctx) {
    var wrap = document.getElementById("livewrap");
    if (!wrap) return;
    var old = wrap.querySelector(".goal-ticker");
    if (old) old.remove();

    // No ticker pre-draft, or when no bracket match is in play.
    if (!draftDone(ctx)) return;
    var anyLive = (ctx.allFixtures || ctx.fixtures || []).some(function (fx) { return Live.INPLAY[fx.status]; });
    if (!anyLive || !state.events.length) return;

    var esc = ctx.helpers.esc;
    var items = state.events.slice().reverse().map(function (e) {
      return '<span class="gt-item"><b>' + esc(e.minute) + "</b> " + esc(e.text) + "</span>";
    }).join("");
    wrap.appendChild(ctx.helpers.el("div", "goal-ticker",
      '<span class="gt-label">⚽ Latest</span><span class="gt-items">' + items + "</span>"));
  }

  /* ---------------- boot ---------------- */

  if (window.Hub) {
    Hub.onRender(function (ctx) {
      if (!ctx || !ctx.standings || !ctx.bracket || !ctx.draft) return;
      renderTicker(ctx);
      schedule(ctx);
    });
  }

  window.LiveDirect = { overlay: overlay, pollNow: poll };
})();
