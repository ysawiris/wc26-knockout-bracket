/* Pick Odds tab — a Monte Carlo forecast of the final knockout
   standings. The model walks the bracket forward from its current
   state: every pending match is decided by a win probability derived
   from XG.fixtureXg (Elo-informed expected goals) when both countries
   have a rating, else from the seed gap; finished matches lock their
   entered winner. Each sim plays the whole tree out — advancing a
   winner through every TBD slot — banks advancement points (R32=3,
   R16=5, QF=8, SF=13, Final=21) plus a per-goal bonus to whichever
   fantasy team drafted each surviving country, then ranks the 12 teams
   by total points (advancePoints + goalBonus, the real standings
   comparator) with a per-sim coin-flip on exact ties. Results are
   cached on a fingerprint of the banked points, live minutes and match
   statuses, so the forecast ticks over as winners are entered while
   idle re-renders reuse the cache. Daily No. 1 snapshots persist in
   localStorage for movement chips and sparklines. Renders into
   #odds-host (inside the Forecast tab); one delegated click/keydown
   listener on the host drives the Projected Advancement round-by-round
   drilldown. Guards out entirely until the snake draft is complete. */

(function () {
  "use strict";

  /* ---------------- tuning constants ---------------- */

  var MAX_SIMS = 5000;       // target simulation count
  var CHUNK = 500;           // sims between wall-clock checks (also the floor)
  var TIME_BUDGET_MS = 90;   // stop adding chunks once we've spent this long
  var SHOW_PCT = 0.10;       // matrix cells print the % at or above this
  var SPREAD_MIN = 0.05;     // a slot counts as "in play" at or above this
  var HIST_KEY = "wc26ko.oddsHist";
  var HIST_DAYS = 40;        // newest N daily snapshots kept
  var SPARK_DAYS = 10;       // sparkline window, in days
  var FALLBACK_AC = "#c89638";
  var SEED_K = 0.045;        // logistic steepness for the seed-gap fallback
  var SHARE_AMP = 1.35;      // how hard an xG goal-share gap becomes a win edge
  var PROB_FLOOR = 0.04;     // every underdog keeps a puncher's chance
  var FALLBACK_SIDE_XG = 1.3;// flat per-side goal expectation when XG is absent
  var FULL_MIN = 95;         // minutes in a "full" match incl. stoppage

  var GOAL_BONUS = (typeof GOAL_BONUS_PER_GOAL === "number") ? GOAL_BONUS_PER_GOAL : 0.1;
  var POINTS = (typeof POINTS_CONFIG === "object" && POINTS_CONFIG) ||
    { R32: 3, R16: 5, QF: 8, SF: 13, Final: 21 };

  /* Defensive copies of the status maps in case script order shifts. */
  var FIN = (window.Live && Live.FINISHED) || { FINISHED: 1, AWARDED: 1 };
  var LIVE_ST = (window.Live && Live.INPLAY) ||
    { IN_PLAY: 1, PAUSED: 1, LIVE: 1, HALFTIME: 1 };

  /* ---------------- module state ---------------- */

  var cache = null;    // { fp: string, res: forecast } — survives re-renders
  var lastCtx = null;  // latest rendered ctx (for any future async re-render)

  /* ---------------- win probability ---------------- */

  /* "63'" -> 63 · "45+2'" -> 47 · null at the break -> 45 · junk -> 47 */
  function parseMinute(minute, status) {
    var atBreak = status === "PAUSED" || status === "HALFTIME";
    if (minute == null || minute === "") return atBreak ? 45 : 47;
    var m = /^(\d+)(?:\+(\d+))?/.exec(String(minute));
    if (!m) return 47;
    return parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) : 0);
  }

  function clampProb(p) {
    return Math.min(Math.max(p, PROB_FLOOR), 1 - PROB_FLOOR);
  }

  /* Probability the HOME country beats the AWAY country in a one-off
     knockout tie. Preference order:
       1. XG.fixtureXg expected goals → a goal-share win edge,
       2. the seed gap through a logistic curve,
       3. an even coin flip.
     Pure (no live state) so the result is cacheable per pairing. */
  function baseWinProb(homeName, awayName, seedHome, seedAway) {
    var xg = (window.XG && typeof XG.fixtureXg === "function")
      ? XG.fixtureXg(homeName, awayName) : null;
    if (xg && isFinite(xg.home) && isFinite(xg.away) && (xg.home + xg.away) > 0) {
      var share = xg.home / (xg.home + xg.away);
      var p = 0.5 + (share - 0.5) * SHARE_AMP; // amplify the share gap
      return clampProb(p);
    }
    if (typeof seedHome === "number" && typeof seedAway === "number") {
      /* Lower seed = stronger; a 1-seed over a 32-seed is a heavy
         favourite. Logistic on the seed gap. */
      var d = seedAway - seedHome; // positive = home is the stronger seed
      return clampProb(1 / (1 + Math.exp(-SEED_K * d)));
    }
    return 0.5;
  }

  /* Expected goals for each side of a match (drives the per-country goal
     bonus). Falls back to a flat league average when XG is unavailable. */
  function sideGoals(homeName, awayName) {
    var xg = (window.XG && typeof XG.fixtureXg === "function")
      ? XG.fixtureXg(homeName, awayName) : null;
    if (xg && isFinite(xg.home) && isFinite(xg.away)) {
      return { home: xg.home, away: xg.away };
    }
    return { home: FALLBACK_SIDE_XG, away: FALLBACK_SIDE_XG };
  }

  /* ---------------- poisson sampler (Knuth) ---------------- */

  /* expNegLambda = Math.exp(-lambda), precomputed per rate. */
  function poisson(expNegLambda) {
    if (!(expNegLambda > 0) || expNegLambda >= 1) return 0;
    var k = 0;
    var p = 1;
    do {
      k += 1;
      p *= Math.random();
    } while (p > expNegLambda);
    return k - 1;
  }

  /* ---------------- bracket walk ---------------- */

  /* Visit every bracket match (rounds in order). */
  function eachMatch(ctx, fn) {
    var rounds = (ctx.bracket && ctx.bracket.rounds) || [];
    rounds.forEach(function (round) {
      (round.matches || []).forEach(function (mt) { fn(mt, round); });
    });
  }

  /* ---------------- fingerprint + cache ---------------- */

  function fingerprint(ctx) {
    var banked = 0;     // advancePoints already locked in
    var bankedG = 0;    // goals banked across the bracket
    ctx.standings.forEach(function (row) {
      banked += row.advancePoints || 0;
      bankedG += row.goals || 0;
    });
    var fin = 0;
    var live = 0;
    var minutes = 0;
    eachMatch(ctx, function (mt) {
      if (FIN[mt.status]) fin += 1;
      else if (LIVE_ST[mt.status]) {
        live += 1;
        minutes += parseMinute(mt.minute, mt.status);
      }
    });
    return [Math.round(banked * 10), bankedG, fin, live, minutes,
      ctx.standings.length, ctx.draft.complete ? 1 : 0].join("|");
  }

  /* ---------------- model ---------------- */

  /* Build a per-round template the sim plays out. Each round carries its
     advancement points and its matches in bracket order; each match knows
     its home/away countryIds (TBD slots stay null until a feeder decides
     them), its win probability and per-side goal expectation, plus the
     structural feeders (the two previous-round match ids that fill its
     slots) so the sim can resolve TBD seats round by round. */
  function buildModel(ctx) {
    var rounds = (ctx.bracket && ctx.bracket.rounds) || [];
    var seedById = {};
    ((ctx.field && ctx.field.list) || []).forEach(function (c) {
      seedById[c.id] = (typeof c.seed === "number") ? c.seed : null;
    });

    var roundDefs = rounds.map(function (round) {
      var pts = (typeof round.points === "number")
        ? round.points
        : (POINTS[round.name] || 0);
      var matches = (round.matches || []).map(function (mt) {
        var hName = mt.home && mt.home.name;
        var aName = mt.away && mt.away.name;
        var fin = !!FIN[mt.status];
        var live = !fin && !!LIVE_ST[mt.status];
        var sg = sideGoals(hName, aName);
        return {
          id: mt.id,
          homeId: (mt.home && mt.home.countryId) || null,
          awayId: (mt.away && mt.away.countryId) || null,
          homeName: hName,
          awayName: aName,
          homeFlag: mt.home && mt.home.flag,
          awayFlag: mt.away && mt.away.flag,
          winnerId: mt.winnerId || null,
          fin: fin,
          live: live,
          homeGoals: mt.homeGoals,
          awayGoals: mt.awayGoals,
          prob: baseWinProb(hName, aName,
            seedById[(mt.home && mt.home.countryId)],
            seedById[(mt.away && mt.away.countryId)]),
          sgHome: sg.home,
          sgAway: sg.away,
          remFrac: fin ? 0 : (live
            ? Math.max(0, (FULL_MIN - parseMinute(mt.minute, mt.status)) / FULL_MIN)
            : 1)
        };
      });
      return { name: round.name, label: round.label, points: pts, matches: matches };
    });

    /* Structural feeders: match m of round r is fed by matches 2m / 2m+1
       of the previous round (the same wiring the core's buildBracket uses). */
    for (var r = 1; r < roundDefs.length; r++) {
      var prev = roundDefs[r - 1].matches;
      roundDefs[r].feeders = roundDefs[r].matches.map(function (mt, m) {
        return [
          prev[m * 2] ? prev[m * 2].id : null,
          prev[m * 2 + 1] ? prev[m * 2 + 1].id : null
        ];
      });
    }

    var started = roundDefs.some(function (rd) {
      return rd.matches.some(function (mt) { return mt.fin || mt.live; });
    });
    return { rounds: roundDefs, started: started };
  }

  /* ---------------- monte carlo ---------------- */

  function runSims(ctx) {
    var standings = ctx.standings;
    var n = standings.length;
    if (!n) return null;

    var model = buildModel(ctx);
    var owners = (ctx.draft && ctx.draft.ownersByCountry) || {};

    /* Index teams like standings, plus baseline banked points/goals. */
    var abbrIdx = {};
    var baseAdv = [];   // advancement points already locked
    var baseGoals = []; // goals already banked
    standings.forEach(function (row, i) {
      abbrIdx[row.team.abbr] = i;
      baseAdv[i] = row.advancePoints || 0;
      baseGoals[i] = row.goals || 0;
    });

    /* Per-round projection (banked vs expected remaining advancement
       points) for the Projected Advancement section + its drilldown. */
    var roundProj = {};
    var roundDetail = {};
    model.rounds.forEach(function (rd) {
      var banked = 0;
      var remain = 0;
      var played = 0;
      var remMatches = 0;
      var detail = [];
      rd.matches.forEach(function (mt) {
        var hOwn = mt.homeId ? (owners[mt.homeId] || null) : null;
        var aOwn = mt.awayId ? (owners[mt.awayId] || null) : null;
        if (mt.fin) {
          played += 1;
          var wOwn = mt.winnerId ? owners[mt.winnerId] : null;
          if (wOwn) banked += rd.points; // a league team's country advanced
        } else if (mt.homeId && mt.awayId) {
          remMatches += 1;
          /* Expected remaining = P(an owned side advances) * round points. */
          var pHomeOwned = hOwn ? mt.prob : 0;
          var pAwayOwned = aOwn ? (1 - mt.prob) : 0;
          remain += (pHomeOwned + pAwayOwned) * rd.points;
        }
        detail.push({
          id: mt.id,
          home: mt.homeName, homeFlag: mt.homeFlag, homeOwner: hOwn,
          away: mt.awayName, awayFlag: mt.awayFlag, awayOwner: aOwn,
          homeGoals: mt.homeGoals, awayGoals: mt.awayGoals,
          fin: mt.fin, live: mt.live, owned: !!(hOwn || aOwn),
          prob: mt.prob, points: rd.points,
          tbd: !(mt.homeId && mt.awayId)
        });
      });
      roundProj[rd.name] = {
        label: rd.label, points: rd.points,
        banked: banked, remain: remain, matches: remMatches, played: played
      };
      roundDetail[rd.name] = detail;
    });

    /* counts[team][slot] = times that team finished in that draft slot. */
    var counts = [];
    var i;
    var k;
    for (i = 0; i < n; i++) {
      counts[i] = [];
      for (k = 0; k < n; k++) counts[i][k] = 0;
    }

    /* Scratch arrays reused every sim to avoid allocation churn. */
    var simAdv = new Array(n);   // advancement points this sim
    var simGoals = new Array(n); // simulated + banked goals this sim
    var simPts = new Array(n);   // total points = advance + goalBonus*goals
    var rnd = new Array(n);
    var idx = new Array(n);
    var winnerOf = {};           // matchId -> countryId for this sim

    function awardGoals(cid, g) {
      if (cid == null || !g) return;
      var ab = owners[cid];
      if (ab != null && abbrIdx[ab] != null) simGoals[abbrIdx[ab]] += g;
    }

    /* The real standings comparator: total points desc (advancePoints +
       goalBonus), tiebreak advancePoints desc, then a per-sim coin flip. */
    function cmp(a, b) {
      return (simPts[b] - simPts[a]) || (simAdv[b] - simAdv[a]) || (rnd[a] - rnd[b]);
    }

    var nRounds = model.rounds.length;

    function simOne() {
      for (i = 0; i < n; i++) {
        simAdv[i] = baseAdv[i];
        simGoals[i] = baseGoals[i];
        rnd[i] = Math.random();
        idx[i] = i;
      }
      winnerOf = {};

      for (var r = 0; r < nRounds; r++) {
        var round = model.rounds[r];
        for (var m = 0; m < round.matches.length; m++) {
          var mt = round.matches[m];
          var homeId = mt.homeId;
          var awayId = mt.awayId;
          /* Later rounds inherit winners decided earlier this sim. */
          if (r > 0 && round.feeders) {
            if (homeId == null) homeId = winnerOf[round.feeders[m][0]] || null;
            if (awayId == null) awayId = winnerOf[round.feeders[m][1]] || null;
          }

          var winId;
          if (mt.fin && mt.winnerId) {
            winId = mt.winnerId; // banked goals already in baseGoals
          } else {
            /* Sample goals for the unplayed share; decide the winner by
               the strength-derived base prob. */
            var rem = mt.remFrac > 0 ? mt.remFrac : 1;
            var hg = poisson(Math.exp(-mt.sgHome * rem));
            var ag = poisson(Math.exp(-mt.sgAway * rem));
            awardGoals(homeId, hg);
            awardGoals(awayId, ag);
            var homeAdvances = Math.random() < mt.prob;
            winId = homeAdvances ? homeId : awayId;
            if (winId == null) winId = homeAdvances ? awayId : homeId;
          }
          winnerOf[mt.id] = winId;

          if (winId != null) {
            var wAbbr = owners[winId];
            if (wAbbr != null && abbrIdx[wAbbr] != null) {
              simAdv[abbrIdx[wAbbr]] += round.points;
            }
          }
        }
      }

      for (i = 0; i < n; i++) {
        simPts[i] = simAdv[i] + simGoals[i] * GOAL_BONUS;
      }
    }

    var t0 = Date.now();
    var done = 0;
    while (done < MAX_SIMS) {
      for (var s = 0; s < CHUNK; s++) {
        simOne();
        idx.sort(cmp);
        for (k = 0; k < n; k++) counts[idx[k]][k] += 1;
      }
      done += CHUNK;
      if (Date.now() - t0 > TIME_BUDGET_MS) break;
    }

    var rows = standings.map(function (row, j) {
      var probs = counts[j].map(function (cnt) { return cnt / done; });
      var expSlot = 0;
      var lo = 0;
      var hi = 0;
      probs.forEach(function (p, slot) {
        expSlot += (slot + 1) * p;
        if (p >= SPREAD_MIN) {
          if (!lo) lo = slot + 1;
          hi = slot + 1;
        }
      });
      return {
        abbr: row.team.abbr,
        name: row.team.name,
        accent: row.team.accent || FALLBACK_AC,
        rank: row.rank,
        pointsNow: row.points || 0,
        advNow: row.advancePoints || 0,
        aliveCount: row.aliveCount || 0,
        reached: row.reached || "—",
        probs: probs,
        expSlot: expSlot,
        lock: probs[(row.rank || 1) - 1] || 0,
        lo: lo || 1,
        hi: hi || n
      };
    });

    /* Deterministic order for identical sim results: expected slot,
       then current rank, then abbr. */
    rows.sort(function (a, b) {
      return (a.expSlot - b.expSlot) || (a.rank - b.rank) ||
        (a.abbr < b.abbr ? -1 : a.abbr > b.abbr ? 1 : 0);
    });

    return {
      sims: done, pre: !model.started, rows: rows,
      roundProj: roundProj, roundDetail: roundDetail,
      complete: !!ctx.draft.complete
    };
  }

  function getForecast(ctx) {
    var fp = fingerprint(ctx);
    if (cache && cache.fp === fp) return cache.res;
    var res = runSims(ctx);
    if (res) cache = { fp: fp, res: res };
    return res;
  }

  /* ---------------- odds history (localStorage) ---------------- */

  function readHist() {
    try {
      var raw = localStorage.getItem(HIST_KEY);
      var h = raw ? JSON.parse(raw) : null;
      return h && typeof h === "object" ? h : {};
    } catch (_) { return {}; } // private mode / quota — history just sits out
  }

  /* "2026-6-11" -> sortable timestamp (helpers.dayKey format). */
  function keyTime(k) {
    var p = String(k).split("-");
    var t = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getTime();
    return isFinite(t) ? t : 0;
  }

  function histP(hist, key, abbr) {
    var day = hist[key];
    var p = day ? day[abbr] : null;
    return typeof p === "number" && isFinite(p) ? p : null;
  }

  /* Overwrite today's snapshot of P(No. 1), prune to the newest HIST_DAYS
     days, persist best-effort. Returns the pruned history. */
  function updateHist(res, todayKey) {
    var snap = {};
    res.rows.forEach(function (r) {
      snap[r.abbr] = Math.round(r.probs[0] * 1000) / 1000;
    });
    var merged = {};
    var prev = readHist();
    Object.keys(prev).forEach(function (k) { merged[k] = prev[k]; });

    /* Keep today's first snapshot unless the forecast materially moved. */
    var today = prev[todayKey];
    if (today) {
      var materially = false;
      Object.keys(snap).forEach(function (abbr) {
        var old = today[abbr];
        if (typeof old !== "number" || Math.abs(snap[abbr] - old) >= 0.02) materially = true;
      });
      if (!materially) return prev;
    }
    merged[todayKey] = snap;

    var next = {};
    Object.keys(merged)
      .sort(function (a, b) { return keyTime(b) - keyTime(a); })
      .slice(0, HIST_DAYS)
      .forEach(function (k) { next[k] = merged[k]; });
    try { localStorage.setItem(HIST_KEY, JSON.stringify(next)); } catch (_) {}
    return next;
  }

  /* P(No. 1) on the most recent stored day BEFORE today (or null). */
  function prevDayP(hist, abbr, todayKey) {
    var keys = Object.keys(hist)
      .filter(function (k) { return keyTime(k) < keyTime(todayKey); })
      .sort(function (a, b) { return keyTime(b) - keyTime(a); });
    for (var i = 0; i < keys.length; i++) {
      var p = histP(hist, keys[i], abbr);
      if (p != null) return p;
    }
    return null;
  }

  /* Last SPARK_DAYS days of P(No. 1) for one team, oldest first. */
  function histSeries(hist, abbr, todayKey) {
    var series = [];
    Object.keys(hist)
      .filter(function (k) { return keyTime(k) <= keyTime(todayKey); })
      .sort(function (a, b) { return keyTime(a) - keyTime(b); })
      .forEach(function (k) {
        var p = histP(hist, k, abbr);
        if (p != null) series.push(p);
      });
    return series.slice(-SPARK_DAYS);
  }

  /* ---------------- formatting ---------------- */

  function fmtPct(p) {
    if (p <= 0) return "0%";
    if (p < 0.005) return "&lt;1%";
    return Math.round(p * 100) + "%";
  }

  function fmtSims(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /* American moneyline from a probability, rounded to the nearest 5
     and capped at ±9900 so the board never prints silly numbers. */
  function moneyline(p) {
    if (p <= 0) return "+9900";
    if (p >= 1) return "-9900";
    var v = p >= 0.5 ? (100 * p) / (1 - p) : (100 * (1 - p)) / p;
    v = Math.round(v / 5) * 5;
    if (v > 9900) v = 9900;
    if (v < 100) v = 100;
    return (p >= 0.5 ? "-" : "+") + v;
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function findMineAbbr(ctx) {
    var abbr = null;
    ctx.standings.forEach(function (row) {
      if (row.team.isMine) abbr = row.team.abbr;
    });
    return abbr;
  }

  /* ---------------- hero cards ---------------- */

  function cardHtml(label, value, detail, dim) {
    return '<div class="od-card">' +
      '<div class="od-card-label">' + label + "</div>" +
      '<div class="od-card-value' + (dim ? " dim" : "") + '">' + value + "</div>" +
      '<div class="od-card-detail">' + detail + "</div>" +
      "</div>";
  }

  function favoriteCard(ctx, board) {
    var fav = board[0];
    if (!fav) return cardHtml("No. 1 finish favorite", "&mdash;", "waiting for data", true);
    var p = fav.probs[0];
    var oneIn = p > 0 ? " · about a 1-in-" + Math.round(1 / p) + " shot" : "";
    return cardHtml("No. 1 finish favorite", fmtPct(p),
      ctx.helpers.esc(fav.name) + " · " + moneyline(p) + oneIn);
  }

  /* Smallest slot whose cumulative probability reaches q. */
  function slotPercentile(probs, q) {
    var cum = 0;
    for (var i = 0; i < probs.length; i++) {
      cum += probs[i];
      if (cum >= q - 1e-9) return i + 1;
    }
    return probs.length;
  }

  function mineCard(ctx, mine) {
    var ord = ctx.helpers.ordinal;
    var best = 0;
    mine.probs.forEach(function (p, i) { if (p > mine.probs[best]) best = i; });
    var slot = best + 1;                          /* most likely finish */
    var lo = slotPercentile(mine.probs, 0.10);    /* central ~80% range */
    var hi = slotPercentile(mine.probs, 0.90);
    var range = lo === hi ? "usually finishes " + lo + ord(lo)
      : "usually finishes " + lo + ord(lo) + "–" + hi + ord(hi);
    return cardHtml("Your forecast", "Finish " + slot + ord(slot),
      range + " · No.1: " + fmtPct(mine.probs[0]));
  }

  /* The bracket round with the most advancement points still on the table
     per match — where the standings can swing hardest next. */
  function hottestCard(ctx, res) {
    var best = null;
    Object.keys(res.roundProj).forEach(function (key) {
      var rp = res.roundProj[key];
      if (rp.matches < 1) return; /* no owned matches left to swing */
      var rate = rp.remain / rp.matches;
      if (!best || rate > best.rate) best = { rp: rp, rate: rate };
    });
    if (!best) return cardHtml("🔥 Hottest round", "&mdash;", "no owned matches left", true);
    return cardHtml("🔥 Hottest round", best.rate.toFixed(1) + " pts/match",
      ctx.helpers.esc(best.rp.label) + " — the biggest swings to come");
  }

  function heroHtml(ctx, res, board, mine) {
    var cards = favoriteCard(ctx, board) +
      (mine ? mineCard(ctx, mine) : "") +
      hottestCard(ctx, res);
    return '<section class="od-block">' +
      '<div class="od-cards' + (mine ? "" : " two") + '">' + cards + "</div></section>";
  }

  /* ---------------- projected advancement: drilldown ---------------- */

  /* Open/closed state per round key (object-as-set) — module level so it
     survives re-renders. */
  var openRounds = {};
  var openInit = false;
  var wired = false; /* delegated listener on #odds-host bound once */

  function toggleRd(host, row) {
    var key = row.getAttribute("data-rd");
    if (!key) return;
    var open = !openRounds[key];
    if (open) openRounds[key] = true;
    else delete openRounds[key];
    var det = host.querySelector('.od-rd-det[data-det="' + key + '"]');
    if (det) det.hidden = !open;
    row.setAttribute("aria-expanded", open ? "true" : "false");
    var caret = row.querySelector(".od-rd-caret");
    if (caret) caret.textContent = open ? "▾" : "▸";
  }

  function wire(host) {
    if (wired) return;
    wired = true;
    host.addEventListener("click", function (e) {
      var row = e.target && e.target.closest ? e.target.closest(".od-rd-row[data-rd]") : null;
      if (row) toggleRd(host, row);
    });
    host.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      var row = e.target && e.target.closest ? e.target.closest(".od-rd-row[data-rd]") : null;
      if (!row) return;
      e.preventDefault();
      toggleRd(host, row);
    });
  }

  /* One compact receipt row per match — finished ties show the points
     banked, pending ties show each side's win probability. A ● marks a
     side a league team drafted. */
  function rdMatchHtml(ctx, d) {
    var esc = ctx.helpers.esc;

    if (d.tbd) {
      return '<div class="od-rd-fx up">' +
        '<span class="od-rd-fx-t">TBD vs TBD</span>' +
        '<span class="od-rd-fx-n">awaiting earlier rounds</span></div>';
    }

    var hasScore = d.homeGoals != null && d.awayGoals != null;
    var score = hasScore ? d.homeGoals + "–" + d.awayGoals : "vs";
    var hOwn = d.homeOwner ? " ●" : "";
    var aOwn = d.awayOwner ? " ●" : "";
    var left = esc(d.homeFlag || "") + " " + esc(d.home || "?") + hOwn + " " + score + " " +
      esc(d.away || "?") + aOwn + " " + esc(d.awayFlag || "");

    var cls;
    var right;
    if (d.fin) {
      cls = "fin";
      right = (d.owned ? "+" + d.points + " pts" : "no league owner") + " ✓";
    } else {
      cls = d.live ? "live" : "up";
      var pHome = Math.round(d.prob * 100);
      var src = (window.XG && XG.RATINGS) ? "Elo" : "seed";
      right = esc(firstWord(d.home)) + " " + pHome + "% · " +
        esc(firstWord(d.away)) + " " + (100 - pHome) + "%" +
        ' <span class="od-rd-src">(' + src + ")</span>";
    }
    return '<div class="od-rd-fx ' + cls + '">' +
      '<span class="od-rd-fx-t">' + left + "</span>" +
      '<span class="od-rd-fx-n">' + right + "</span></div>";
  }

  /* Compact first word of a country name for the win-prob receipts. */
  function firstWord(name) {
    if (!name) return "?";
    return String(name).split(" ")[0];
  }

  function rdDetailHtml(ctx, res, key) {
    var list = (res.roundDetail && res.roundDetail[key]) || [];
    var rp = res.roundProj[key] || { banked: 0, remain: 0 };
    var rows = list.map(function (d) { return rdMatchHtml(ctx, d); }).join("");
    return rows + '<div class="od-rd-det-foot">banked ' + rp.banked +
      " + expected ~" + rp.remain.toFixed(1) + " ≈ " +
      Math.round(rp.banked + rp.remain) +
      " advancement points to league teams this round.</div>";
  }

  /* ---------------- projected advancement ---------------- */

  /* The league's currency: advancement points (won ties, weighted by
     round) plus a small goal bonus. One stacked bar per bracket round —
     solid gold for points already banked by league teams, striped for
     what the model still expects — ordered by bracket ordinal. Each row
     expands (click/Enter/Space) into its match-by-match receipts. */
  function projHtml(ctx, res) {
    var esc = ctx.helpers.esc;

    var ordinalByKey = {};
    ((ctx.bracket && ctx.bracket.rounds) || []).forEach(function (round) {
      ordinalByKey[round.name] = round.ordinal || 0;
    });
    var keys = Object.keys(res.roundProj);
    keys.sort(function (a, b) { return (ordinalByKey[a] || 0) - (ordinalByKey[b] || 0); });

    var maxTotal = 0.001;
    keys.forEach(function (key) {
      var rp = res.roundProj[key];
      var t = rp.banked + rp.remain;
      if (t > maxTotal) maxTotal = t;
    });

    var html = keys.map(function (key) {
      var rp = res.roundProj[key];
      var total = rp.banked + rp.remain;
      var bankedW = (rp.banked / maxTotal) * 100;
      var remainW = (rp.remain / maxTotal) * 100;
      var open = !!openRounds[key];
      var detId = "od-rd-det-" + esc(key);
      return '<div class="od-rd-grp">' +
        '<div class="od-rd-row" role="button" tabindex="0" data-rd="' + esc(key) +
        '" aria-expanded="' + (open ? "true" : "false") +
        '" aria-controls="' + detId + '">' +
        '<span class="od-rd-caret" aria-hidden="true">' + (open ? "▾" : "▸") + "</span>" +
        '<span class="od-rd-name">' + esc(rp.label) + "</span>" +
        '<span class="od-rd-letter">' + rp.points + "</span>" +
        '<span class="od-rd-bar">' +
          '<span class="od-rd-banked" style="width:' + bankedW.toFixed(1) + '%"></span>' +
          '<span class="od-rd-remain" style="width:' + remainW.toFixed(1) + '%"></span>' +
        "</span>" +
        '<span class="od-rd-num">' + rp.banked + " + ~" + Math.round(rp.remain) +
          " ≈ " + Math.round(total) + "</span>" +
        "</div>" +
        '<div class="od-rd-det" id="' + detId + '" data-det="' + esc(key) + '"' +
          (open ? "" : " hidden") + ">" +
          rdDetailHtml(ctx, res, key) +
        "</div></div>";
    }).join("");

    return '<section class="od-block">' +
      '<div class="od-head">⚽ Projected Advancement ' +
        '<span class="od-head-sub">· points league teams bank by round</span></div>' +
      '<div class="od-rd">' + html + "</div></section>";
  }

  /* ---------------- the board ---------------- */

  function moveChipHtml(p, prev) {
    if (prev == null) return "";
    var d = Math.round(p * 100) - Math.round(prev * 100);
    /* Sub-2pp moves are within Monte Carlo re-roll noise — only real
       movement gets a chip. */
    if (Math.abs(d) < 2) return "";
    var up = d > 0;
    return '<span class="od-chip ' + (up ? "up" : "down") +
      '" title="percentage points vs the last stored day">' +
      (up ? "▲ " : "▼ ") + Math.abs(d) + "</span>";
  }

  function sparkHtml(series) {
    if (series.length < 2) return "";
    var max = Math.max(0.01, Math.max.apply(null, series));
    var step = 60 / (series.length - 1);
    var pts = series.map(function (p, i) {
      return (i * step).toFixed(1) + "," + (17 - (p / max) * 16).toFixed(1);
    }).join(" ");
    return '<svg class="od-spark" viewBox="0 0 60 18" preserveAspectRatio="none" ' +
      'aria-hidden="true"><polyline points="' + pts + '"></polyline></svg>';
  }

  function boardHtml(ctx, board, hist, todayKey, mineAbbr) {
    var esc = ctx.helpers.esc;
    var maxP = board.length ? Math.max(board[0].probs[0], 0.001) : 0.001;

    var rows = board.map(function (r, i) {
      var p = r.probs[0];
      var width = Math.max((p / maxP) * 100, 1.5);
      var mine = r.abbr === mineAbbr;
      return '<div class="od-bd-row' + (mine ? " mine" : "") +
        '" style="--od-ac:' + esc(r.accent) + '">' +
        '<span class="od-bd-dot">' + (i + 1) + "</span>" +
        '<span class="od-bd-name">' + esc(r.name) + (mine ? " ⭐" : "") + "</span>" +
        '<span class="od-bd-bar"><span class="od-bd-fill" style="width:' +
          width.toFixed(1) + '%"></span></span>' +
        '<span class="od-bd-pct">' + fmtPct(p) + "</span>" +
        '<span class="od-bd-ml">' + moneyline(p) + "</span>" +
        '<span class="od-bd-move">' + moveChipHtml(p, prevDayP(hist, r.abbr, todayKey)) + "</span>" +
        '<span class="od-bd-graph">' + sparkHtml(histSeries(hist, r.abbr, todayKey)) + "</span>" +
        "</div>";
    }).join("");

    return '<section class="od-block">' +
      '<div class="od-head">🎯 The Board <span class="od-head-sub">· odds to finish No. 1 overall</span></div>' +
      '<div class="od-board">' + rows + "</div></section>";
  }

  /* ---------------- path to No. 1 ---------------- */

  function signedPts(n) {
    return Math.round(n * 10) / 10;
  }

  function pathHtml(ctx, res, board, mine) {
    var esc = ctx.helpers.esc;
    var text;

    if (board[0] && board[0].abbr === mine.abbr) {
      var chall = board[1];
      if (!chall) return "";
      var back = mine.pointsNow - chall.pointsNow; /* signed */
      var standing = back > 0 ? "is " + plural(signedPts(back), "point") + " back"
        : back === 0 ? "is level on points"
        : "actually leads by " + plural(signedPts(-back), "point");
      text = "👑 Favorites — defend it: " + esc(chall.abbr) + " " + standing +
        " with " + plural(chall.aliveCount, "country") + " still alive" +
        (back < 0 ? " — your draft-slot edge keeps you on top" : "") + ".";
    } else {
      var rival = board[0]; /* the model favorite is the team to beat */
      if (!rival) return "";
      var gap = rival.pointsNow - mine.pointsNow; /* signed */
      var p = mine.probs[0];
      var tier = p >= 0.4 ? "strong shot" : p >= 0.2 ? "live shot"
        : p >= 0.08 ? "outside shot" : "long shot";
      var opener = gap > 0 ? "You trail " + esc(rival.name) + " by " +
          plural(signedPts(gap), "point")
        : gap === 0 ? "You're level on points with " + esc(rival.name)
        : "You lead " + esc(rival.name) + " by " + plural(signedPts(-gap), "point") +
          ", but their bracket makes them the favorite";
      text = opener +
        "; you have <b>" + plural(mine.aliveCount, "country") + " alive</b> (reached " +
        esc(mine.reached) + ") vs theirs <b>" + plural(rival.aliveCount, "country") +
        "</b> — " + tier + " (" + fmtPct(p) + ").";
    }

    return '<section class="od-block">' +
      '<div class="od-head">🧭 Path to No. 1</div>' +
      '<div class="od-path">' + text + "</div></section>";
  }

  /* ---------------- odds matrix ---------------- */

  function matrixCell(p) {
    var cls = "od-cell";
    var txt = "";
    if (p >= SHOW_PCT) {
      txt = Math.round(p * 100) + "%";
      if (p >= 0.55) cls += " hot";
    } else if (p > 0) {
      txt = "·";
      cls += " dot";
    }
    /* Shade intensity tracks probability; floor keeps tiny odds visible. */
    var alpha = p > 0 ? Math.min(0.06 + p * 0.86, 0.92) : 0;
    return '<td class="' + cls + '" style="--od-a:' + alpha.toFixed(2) + '">' + txt + "</td>";
  }

  function matrixHtml(ctx, res, mineAbbr) {
    var esc = ctx.helpers.esc;
    var n = res.rows.length;
    var head = '<tr><th class="od-team-h" scope="col">Team</th>' +
      '<th class="od-pick" scope="col">avg</th>';
    for (var k = 1; k <= n; k++) {
      head += '<th class="od-pick" scope="col">' + k + "</th>";
    }
    head += "</tr>";

    var body = res.rows.map(function (r) {
      var mine = r.abbr === mineAbbr;
      var cells = r.probs.map(matrixCell).join("");
      return '<tr class="od-row' + (mine ? " mine" : "") + '" style="--od-ac:' + esc(r.accent) + '">' +
        '<th class="od-team" scope="row">' +
        '<span class="od-tn-full">' + esc(r.name) + "</span>" +
        '<span class="od-tn-abbr">' + esc(r.abbr) + "</span>" + (mine ? " ⭐" : "") +
        "</th>" +
        '<td class="od-exp">' + r.expSlot.toFixed(1) + "</td>" +
        cells + "</tr>";
    }).join("");

    return '<section class="od-block">' +
      '<div class="od-head">🎲 Final-Standings Probability Matrix ' +
        '<span class="od-head-sub od-swipe-hint">· swipe for slots →</span></div>' +
      '<div class="od-matrix"><table class="od-table">' +
        "<thead>" + head + "</thead><tbody>" + body + "</tbody>" +
      "</table></div>" +
      '<p class="od-foot">Each cell: how often that team finished in that ' +
        "final standing slot across the sims. avg = their average finish.</p>" +
      "</section>";
  }

  /* ---------------- how this works ---------------- */

  function howHtml(res) {
    var ratingSrc = (window.XG && XG.RATINGS) ? "Elo team-strength ratings"
      : "the bracket seeding";
    var steps = [
      "Your league standing = total advancement points from your 2 drafted " +
        "countries across the knockout bracket. Winning a Round of 32 tie is " +
        "worth " + POINTS.R32 + " points, Round of 16 " + POINTS.R16 + ", " +
        "Quarterfinal " + POINTS.QF + ", Semifinal " + POINTS.SF + ", and the " +
        "Final " + POINTS.Final + ". Every goal your countries score adds " +
        GOAL_BONUS + " of a point.",
      "Each undecided match gets a win probability from " + ratingSrc +
        " — the stronger country is favored, but upsets happen.",
      "A computer plays the rest of the bracket out " + fmtSims(res.sims) +
        " times, advancing a winner in every tie and banking the points to " +
        "whichever league team drafted them.",
      "How often your team finishes with the most points across all those " +
        "runs = your odds to land the No. 1 final standing.",
      "Betting-odds format: +480 means a $100 bet would profit $480 — " +
        "roughly a 1-in-6 shot. Bigger plus number = longer shot.",
      "▲/▼ chips show how a team's No.1 chance moved since yesterday " +
        "(on this device)."
    ];
    var method = fmtSims(res.sims) +
      " sims · " + ratingSrc + " · winners advance through the bracket · " +
      "ties break on advancement points then draft order";
    return '<section class="od-block">' +
      '<div class="od-head">📖 How this works</div>' +
      '<div class="od-how"><ol>' +
      steps.map(function (s) { return "<li>" + s + "</li>"; }).join("") +
      '</ol><p class="od-method">' + method + "</p></div></section>";
  }

  /* ---------------- render ---------------- */

  function render(ctx) {
    var host = document.getElementById("odds-host");
    if (!host) return;
    /* Never throw on the new ctx — guard the shape up front. */
    if (!ctx || !ctx.standings || !ctx.bracket || !ctx.draft) return;
    try {
      wire(host); /* delegated drilldown listener — bound once, host persists */

      if (!ctx.standings.length) {
        host.innerHTML = '<p class="od-empty">Waiting for draft data…</p>';
        return;
      }

      /* Draft gate — the forecast is meaningless until both picks per
         team are locked in. */
      if (!ctx.draft.complete) {
        host.innerHTML = '<div class="od-wrap"><p class="od-empty">' +
          "The forecast unlocks once the snake draft is complete. Finish " +
          "drafting both countries for all 12 teams, then this Monte Carlo " +
          "projects the final standings.</p></div>";
        return;
      }

      lastCtx = ctx;
      var res = getForecast(ctx);
      if (!res) {
        host.innerHTML = '<p class="od-empty">Waiting for draft data…</p>';
        return;
      }

      /* On first render, open the earliest round that still has owned
         swings, so something useful is visible. */
      if (!openInit) {
        openInit = true;
        var rounds = (ctx.bracket && ctx.bracket.rounds) || [];
        for (var i = 0; i < rounds.length; i++) {
          var rp = res.roundProj[rounds[i].name];
          if (rp && rp.matches > 0) { openRounds[rounds[i].name] = true; break; }
        }
      }

      var todayKey = ctx.helpers.dayKey(new Date());
      var hist = updateHist(res, todayKey); // once per render, overwrite today

      var mineAbbr = findMineAbbr(ctx);
      var mine = null;
      res.rows.forEach(function (r) { if (r.abbr === mineAbbr) mine = r; });

      var board = res.rows.slice().sort(function (a, b) {
        return (b.probs[0] - a.probs[0]) || (a.expSlot - b.expSlot) ||
          (a.abbr < b.abbr ? -1 : a.abbr > b.abbr ? 1 : 0);
      });

      /* The matrix scrolls sideways on phones; an innerHTML rebuild
         resets that, so stash and restore its scroll position. */
      var scroller = host.querySelector(".od-matrix");
      var scrollX = scroller ? scroller.scrollLeft : 0;

      host.innerHTML = '<div class="od-wrap">' +
        (res.pre ? '<div class="od-banner">Strength-based forecast — sharpens with every result you enter.</div>' : "") +
        heroHtml(ctx, res, board, mine) +
        projHtml(ctx, res) +
        boardHtml(ctx, board, hist, todayKey, mineAbbr) +
        (mine ? pathHtml(ctx, res, board, mine) : "") +
        matrixHtml(ctx, res, mineAbbr) +
        howHtml(res) +
        "</div>";

      scroller = host.querySelector(".od-matrix");
      if (scroller && scrollX) scroller.scrollLeft = scrollX;
    } catch (err) {
      console.error("Pick Odds render failed:", err);
    }
  }

  if (window.Hub && typeof window.Hub.onRender === "function") Hub.onRender(render);

  /* Expected total goals in one match — the two side rates summed. */
  function matchLambda(homeName, awayName) {
    var s = sideGoals(homeName, awayName);
    return s.home + s.away;
  }

  /* Debug/console surface — pure helpers plus the forecast probe.
     teamLambdas/matchLambda bridge the Elo expected-goals model into the
     shape js/matchcenter.js expects (PickOdds.teamLambdas → { home, away }),
     so the Match Center win-probability bar reflects real team strength
     instead of falling back to a symmetric 1.3/1.3 coin-flip. */
  window.PickOdds = {
    parseMinute: parseMinute,
    moneyline: moneyline,
    baseWinProb: baseWinProb,
    teamLambdas: sideGoals,
    matchLambda: matchLambda,
    forecast: getForecast
  };
})();
