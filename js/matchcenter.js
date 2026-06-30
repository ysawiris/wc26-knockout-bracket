/* ============================================================
   Match Center — a Google-style full match panel, opened from a
   single "📊 Match" button on every fixture (replaces the old
   ▶ Highlights link and 📝 Recap modal). Works for finished, live
   and upcoming games.

   Modelled on Google's football match card (score hero, scorers
   row, Timeline / Stats / Bracket tabs, win-probability bar,
   comparison stats, bracket slice) but rendered in the hub's
   gold-on-dark theme.

   KNOCKOUT MODEL: there are no groups. The hero stage label reads
   the bracket round (Round of 32 … Final) off fx.roundLabel/round,
   the old group W/D/L table is replaced by a bracket slice showing
   this match's round and the winner's path forward, and ownership is
   the fantasy team that DRAFTED each country (ctx.helpers.
   countryTeamOwner + ctx.draft.countriesByTeam) rather than a group
   owner. Cards/fouls are display-only and never score.

   Decoupled from the renderers: it finds the fixture in the live
   Hub.ctx() by id on click, so it always reflects the latest data
   (live scores re-render the cards, never this panel directly).
   Goal-by-goal detail comes from data/recaps.json (finished games);
   live games lean on the live score, minute, cards and a modelled
   win probability. Real betting totals (over/under) come from
   data/odds.json for upcoming games.
   ============================================================ */

var MatchCenter = (function () {
  "use strict";

  var recapsById = {};
  var oddsLines = [];

  /* ---------------- shared helpers ---------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function norm(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z]+/g, " ")
      .trim();
  }

  /* The FIELD country object for a fixture team name (flag, colours). */
  function country(name) {
    try { return (window.Live && Live.resolveCountry(name)) || null; }
    catch (err) { return null; }
  }
  function teamColor(name) {
    var c = country(name);
    return (c && (c.c1 || c.accent)) || "#c89638";
  }
  function flagFor(name) {
    var c = country(name);
    return c ? c.flag : "";
  }

  /* The live Hub context (frozen knockout contract). */
  function hubCtx() {
    try { return (window.Hub && Hub.ctx()) || null; }
    catch (err) { return null; }
  }

  /* The fantasy team object (abbr/name/accent/isMine) that drafted a country,
     resolved by countryId via the frozen ctx helper. Null when undrafted. */
  function draftOwner(countryId) {
    if (!countryId) return null;
    var ctx = hubCtx();
    if (!ctx || !ctx.helpers || !ctx.helpers.countryTeamOwner) return null;
    var abbr = ctx.helpers.countryTeamOwner(countryId);
    if (!abbr) return null;
    var teams = (ctx.teams || []);
    for (var i = 0; i < teams.length; i++) {
      if (teams[i].abbr === abbr) return teams[i];
    }
    return { abbr: abbr, name: abbr, isMine: false };
  }

  /* "Drafted by <team>" label for one fixture side, or "Undrafted". */
  function ownerLabel(side) {
    var owner = draftOwner(side && side.countryId);
    if (!owner) return "Undrafted";
    return esc(owner.name) + (owner.isMine ? " ⭐" : "");
  }

  /* ---------------- data loads (both cheap + cache-busted) ---------------- */

  function loadRecaps() {
    return fetch("data/recaps.json?v=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (data) { recapsById = (data && data.byId) || {}; });
  }

  function loadOdds() {
    return fetch("data/odds.json?v=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (data) { oddsLines = (data && data.lines) || []; });
  }

  function oddsFor(fx) {
    var h = norm(fx.home.name), a = norm(fx.away.name);
    return oddsLines.find(function (l) {
      var lh = norm(l.home), la = norm(l.away);
      return (lh === h && la === a) || (lh === a && la === h);
    }) || null;
  }

  /* ---------------- status ---------------- */

  function isLive(fx) { return !!(window.Live && Live.INPLAY[fx.status]); }
  function isDone(fx) { return !!(window.Live && Live.FINISHED[fx.status]); }
  function hasScore(fx) { return fx.homeGoals != null && fx.awayGoals != null; }

  /* Minute elapsed as a number, best-effort (e.g. "53'", "90+2'" → 53 / 92). */
  function minuteNum(fx) {
    var m = String(fx.minute || "").match(/(\d+)(?:\+(\d+))?/);
    if (!m) return null;
    return Number(m[1]) + (m[2] ? Number(m[2]) : 0);
  }

  /* ---------------- win probability (transparent model) ----------------
     Remaining goals for each side ~ independent Poisson, mean scaled by the
     share of the match still to play (symmetric — no team-strength input, so
     a level game stays a coin-flip plus the draw mass). Finished games put all
     mass on the final score, so the winner reads ~100%. Clearly an estimate. */
  function poissonPmf(k, lambda) {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    var p = Math.exp(-lambda);
    for (var i = 1; i <= k; i++) p *= lambda / i;
    return p;
  }

  /* Per-team expected goals. Pulls the shared Elo strength model from odds.js
     (one source of truth — Brazil 2.0/0.8, Morocco 1.6/0.8, …) so the win
     probability reflects who's actually better, then anchors the magnitude to
     the bookmaker total (data/odds.json) when one exists. Symmetric fallback
     if odds.js hasn't loaded. */
  function teamLambdas(fx) {
    var base = null;
    try {
      if (window.PickOdds && PickOdds.teamLambdas) base = PickOdds.teamLambdas(fx.home.name, fx.away.name);
    } catch (err) { base = null; }
    if (!base || base.home == null || base.away == null) base = { home: 1.3, away: 1.3 };
    var o = oddsFor(fx);
    var sum = base.home + base.away;
    if (o && o.impliedTotal && sum > 0) {
      var k = o.impliedTotal / sum; // keep the strength ratio, use the market total
      base = { home: base.home * k, away: base.away * k };
    }
    return base;
  }

  /* Win probability from the strength model + the live score and time left.
     Team-aware (the favourite shows through) and live (recomputes from the
     minute): remaining goals for each side ~ independent Poisson on its
     expected rate, scaled by the share of the match still to play. Finished
     games collapse onto the final score; upcoming games use the full pre-match
     rate. Returns home/draw/away plus a `pre` flag for labelling. */
  function winProb(fx) {
    var pre = !isLive(fx) && !isDone(fx);
    var hg = fx.homeGoals || 0, ag = fx.awayGoals || 0;
    var elapsed = isDone(fx) ? 95 : (isLive(fx) ? (minuteNum(fx) || 1) : 0);
    var remaining = Math.max(0, 95 - elapsed) / 95;
    var lam = teamLambdas(fx);
    var lh = lam.home * remaining, la = lam.away * remaining;
    var pH = 0, pD = 0, pA = 0;
    for (var h = 0; h <= 10; h++) {
      for (var a = 0; a <= 10; a++) {
        var p = poissonPmf(h, lh) * poissonPmf(a, la);
        var fh = hg + h, fa = ag + a;
        if (fh > fa) pH += p; else if (fh < fa) pA += p; else pD += p;
      }
    }
    var tot = pH + pD + pA || 1;
    return { h: pH / tot, d: pD / tot, a: pA / tot, pre: pre };
  }

  /* ---------------- bracket slice (this match's round + the road on) -------
     Replaces the old group W/D/L table. Finds the fixture's match in the live
     ctx.bracket, then shows its round (siblings) and the winner's next match
     so the path to the trophy is visible. No qualification key — in knockout
     the winner simply advances, there is no "top 2". */

  /* The round name (R32, R16, …) for a fixture, off the fixture or its
     bracket match. */
  function roundKeyOf(fx) {
    return (fx && fx.round) || null;
  }

  /* Find the bracket match object (with winnerId etc.) for a fixture id. */
  function bracketMatch(ctx, id) {
    var rounds = (ctx && ctx.bracket && ctx.bracket.rounds) || [];
    for (var r = 0; r < rounds.length; r++) {
      var ms = rounds[r].matches || [];
      for (var i = 0; i < ms.length; i++) {
        if (String(ms[i].id) === String(id)) return { match: ms[i], roundIdx: r };
      }
    }
    return null;
  }

  /* The match in the next round this match feeds into (winner's destination),
     or null if this is the Final / the next round can't be located. The
     bracket builder pairs match m of round r into match floor(m/2) of r+1. */
  function nextMatch(ctx, roundIdx, matchIdx) {
    var rounds = (ctx && ctx.bracket && ctx.bracket.rounds) || [];
    var next = rounds[roundIdx + 1];
    if (!next || !next.matches) return null;
    return next.matches[Math.floor(matchIdx / 2)] || null;
  }

  /* ---------------- hero ---------------- */

  function statusChip(fx) {
    if (isLive(fx)) {
      var lbl = (fx.status === "PAUSED" || fx.status === "HALFTIME")
        ? "Half-time" : ("Live" + (fx.minute ? " · " + esc(fx.minute) : ""));
      return '<span class="mc-state live"><span class="mc-dot"></span>' + lbl + "</span>";
    }
    if (isDone(fx)) return '<span class="mc-state done">Full time</span>';
    if (fx.status === "POSTPONED" || fx.status === "SUSPENDED" || fx.status === "CANCELLED") {
      return '<span class="mc-state">' + esc(fx.status.charAt(0) + fx.status.slice(1).toLowerCase()) + "</span>";
    }
    var t = kickoffTime(fx);
    return '<span class="mc-state up">' + (t ? esc(t) : "Upcoming") + "</span>";
  }

  function kickoffTime(fx) {
    if (!fx.utcDate) return null;
    var d = new Date(fx.utcDate);
    if (isNaN(d)) return null;
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function kickoffFull(fx) {
    if (!fx.utcDate) return fx.dateISO || "";
    var d = new Date(fx.utcDate);
    if (isNaN(d)) return fx.dateISO || "";
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) +
      " · " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  /* The user-facing round label ("Round of 32" …), falling back to the round
     key, and finally to a generic "Knockout" if the fixture has neither. */
  function stageLabel(fx) {
    return fx.roundLabel || fx.round || "Knockout";
  }

  function teamBlock(fx, side) {
    var team = fx[side];
    return '<div class="mc-team ' + side + '">' +
      '<span class="mc-flag">' + flagFor(team.name) + "</span>" +
      '<span class="mc-tname">' + esc(team.name || "TBD") + "</span>" +
      "</div>";
  }

  function scorersRow(fx) {
    var r = fx.matchId && recapsById[fx.matchId];
    if (!r || !r.goals || !r.goals.length) return "";
    var home = [], away = [];
    r.goals.forEach(function (g) {
      var tag = g.ownGoal ? " (og)" : g.penalty ? " (pen)" : "";
      var label = esc(g.player) + tag + " " + esc(g.minute);
      (g.side === "away" ? away : home).push(label);
    });
    return '<div class="mc-scorers">' +
      '<div class="mc-sc home">' + (home.join("<br>") || "&nbsp;") + "</div>" +
      '<div class="mc-sc-ico">⚽</div>' +
      '<div class="mc-sc away">' + (away.join("<br>") || "&nbsp;") + "</div>" +
      "</div>";
  }

  /* The match's penalty-shootout record from recaps.json (or null). */
  function shootoutOf(fx) {
    var r = fx.matchId && recapsById[fx.matchId];
    return (r && r.shootout && r.shootout.kicks && r.shootout.kicks.length) ? r.shootout : null;
  }

  /* Compact one-line shootout result for the hero ("Morocco win 3–2 on
     penalties") so a level scoreline isn't misread as a draw. */
  function shootoutLine(fx) {
    var so = shootoutOf(fx);
    if (!so) return "";
    var label;
    if (so.winner) {
      var name = so.winner === "home" ? fx.home.name : fx.away.name;
      var w = so.winner === "home" ? so.home : so.away;
      var l = so.winner === "home" ? so.away : so.home;
      label = esc(name) + " win " + w + "–" + l + " on penalties";
    } else {
      label = "Shootout " + so.home + "–" + so.away;
    }
    return '<div class="mc-pk-line">🥅 ' + label + "</div>";
  }

  /* Full kick-by-kick shootout grid for the timeline: one row per team, each
     team's kicks in taking order as ✓ (scored) / ✗ (missed), with the tally.
     Winner row highlighted. Each mark's title names the taker. */
  function shootoutBlock(fx) {
    var so = shootoutOf(fx);
    if (!so) return "";
    function row(side) {
      var name = fx[side].name;
      var marks = so.kicks.filter(function (k) { return k.side === side; })
        .map(function (k) {
          var t = k.player ? esc(k.player) + (k.scored ? " — scored" : " — missed") : (k.scored ? "Scored" : "Missed");
          return '<i class="mc-pk-k ' + (k.scored ? "goal" : "miss") + '" title="' + t + '">' +
            (k.scored ? "✓" : "✗") + "</i>";
        }).join("");
      var tally = side === "home" ? so.home : so.away;
      return '<div class="mc-pk-row' + (so.winner === side ? " win" : "") + '">' +
        '<span class="mc-pk-team">' + flagFor(name) + " " + esc(name || "TBD") + "</span>" +
        '<span class="mc-pk-kicks">' + marks + "</span>" +
        '<span class="mc-pk-tally">' + tally + "</span>" +
        "</div>";
    }
    var head = so.winner
      ? esc(so.winner === "home" ? fx.home.name : fx.away.name) + " advance on penalties"
      : "Penalty shootout";
    return '<div class="mc-pk">' +
      '<div class="mc-pk-h">🥅 ' + head + "</div>" +
      row("home") + row("away") +
      "</div>";
  }

  function hero(fx) {
    var score = hasScore(fx)
      ? fx.homeGoals + '<span class="mc-dash">–</span>' + fx.awayGoals
      : '<span class="mc-vs">vs</span>';
    var stage = "Knockout · " + esc(stageLabel(fx)) +
      (fx.matchNumber ? " · Match " + esc(fx.matchNumber) : "");
    return '<div class="mc-hero">' +
      '<div class="mc-hero-top">' +
        '<span class="mc-comp">FIFA World Cup 2026™</span>' + statusChip(fx) +
      "</div>" +
      '<div class="mc-scoreline">' +
        teamBlock(fx, "home") +
        '<div class="mc-nums">' + score + "</div>" +
        teamBlock(fx, "away") +
      "</div>" +
      '<div class="mc-stage">' + stage + "</div>" +
      scorersRow(fx) +
      shootoutLine(fx) +
      ((isDone(fx) || isLive(fx))
        ? '<a class="mc-watch" target="_blank" rel="noopener" href="' +
            Live.highlightsUrl(fx.home.name, fx.away.name) + '">▶ Watch highlights</a>'
        : "") +
      "</div>";
  }

  /* ---------------- Timeline tab ---------------- */

  function goalLi(g) {
    var icon = g.ownGoal ? "🥅" : (g.penalty ? "⚽" : "⚽");
    var tags = "";
    if (g.ownGoal) tags += '<span class="mc-tag og">o.g.</span>';
    if (g.penalty) tags += '<span class="mc-tag pen">pen</span>';
    return '<li class="mc-ev ' + (g.side === "away" ? "away" : "home") + '">' +
      '<span class="mc-ev-min">' + esc(g.minute) + "</span>" +
      '<span class="mc-ev-ico">' + icon + "</span>" +
      '<span class="mc-ev-body"><b>' + esc(g.player) + "</b>" + tags +
        '<span class="mc-ev-team">' + flagFor(g.team) + " " + esc(g.team) + "</span></span>" +
      "</li>";
  }

  function timelinePanel(fx) {
    var r = fx.matchId && recapsById[fx.matchId];
    if (r && r.goals && r.goals.length) {
      var sorted = r.goals.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      return (r.summary ? '<p class="mc-summary">' + esc(r.summary) + "</p>" : "") +
        '<ul class="mc-evs">' + sorted.map(goalLi).join("") + "</ul>" +
        shootoutBlock(fx);
    }
    // Level game with a shootout but no open-play goals still shows the shootout.
    if (shootoutOf(fx)) {
      return (r && r.summary ? '<p class="mc-summary">' + esc(r.summary) + "</p>" : "") +
        shootoutBlock(fx);
    }
    if (isLive(fx)) {
      return '<div class="mc-note live">' +
        '<span class="mc-dot"></span> Live — it\'s ' +
        (hasScore(fx) ? fx.homeGoals + "–" + fx.awayGoals : "underway") +
        (fx.minute ? " at " + esc(fx.minute) : "") + ". " +
        "Goal-by-goal detail lands when the match recap is generated after full time." +
        "</div>";
    }
    if (isDone(fx)) {
      return '<div class="mc-note">Final score ' + (hasScore(fx) ? fx.homeGoals + "–" + fx.awayGoals : "—") +
        ". A detailed timeline isn't available for this match yet.</div>";
    }
    // upcoming preview
    return '<div class="mc-note">Kicks off ' + esc(kickoffFull(fx)) + "." +
      (fx.venue ? " " + esc(fx.venue) + "." : "") + "</div>";
  }

  /* ---------------- Stats tab ---------------- */

  function winProbCard(fx) {
    var wp = winProb(fx);
    if (!wp) return "";
    var foot = isDone(fx) ? "Final result"
      : wp.pre ? "Pre-match estimate · team-strength model"
      : "Live estimate · team strength + score &amp; time left";
    var hc = teamColor(fx.home.name), ac = teamColor(fx.away.name);
    var pc = function (x) { return Math.round(x * 100); };
    return '<div class="mc-card mc-wp">' +
      '<div class="mc-card-h">Win probability</div>' +
      '<div class="mc-wp-legend">' +
        '<span class="l"><b style="color:' + hc + '">' + esc(fx.home.name) + "</b>" + pc(wp.h) + "%</span>" +
        '<span class="c">Draw ' + pc(wp.d) + "%</span>" +
        '<span class="r"><b style="color:' + ac + '">' + esc(fx.away.name) + "</b>" + pc(wp.a) + "%</span>" +
      "</div>" +
      '<div class="mc-wp-bar">' +
        '<span style="width:' + pc(wp.h) + "%;background:" + hc + '"></span>' +
        '<span class="draw" style="width:' + pc(wp.d) + '%"></span>' +
        '<span style="width:' + pc(wp.a) + "%;background:" + ac + '"></span>' +
      "</div>" +
      '<div class="mc-wp-foot">' + foot + "</div>" +
      "</div>";
  }

  function statRow(label, hv, av) {
    if (hv == null && av == null) return "";
    var h = hv == null ? 0 : hv, a = av == null ? 0 : av;
    var hLead = h > a ? " lead" : "", aLead = a > h ? " lead" : "";
    return '<div class="mc-srow">' +
      '<span class="mc-sv home' + hLead + '">' + h + "</span>" +
      '<span class="mc-slabel">' + label + "</span>" +
      '<span class="mc-sv away' + aLead + '">' + a + "</span>" +
      "</div>";
  }

  function statsPanel(fx) {
    var blocks = winProbCard(fx);

    // Per-match stats we actually have: goals + (when the live feed supplies
    // them) yellow/red cards and fouls. Cards/fouls are display-only in
    // knockout (they never score). No invented shots/possession.
    var c = fx.cards || {};
    var ch = c.home || {}, ca = c.away || {};
    var rows = "";
    if (hasScore(fx)) rows += statRow("Goals", fx.homeGoals, fx.awayGoals);
    if (ch.y != null || ca.y != null) rows += statRow("Yellow cards", ch.y || 0, ca.y || 0);
    if (ch.r != null || ca.r != null) rows += statRow("Red cards", ch.r || 0, ca.r || 0);
    if (ch.f != null || ca.f != null) rows += statRow("Fouls", ch.f || 0, ca.f || 0);
    if (rows) {
      blocks += '<div class="mc-card mc-stats">' +
        '<div class="mc-card-h"><span>' + flagFor(fx.home.name) + "</span>Match stats<span>" +
          flagFor(fx.away.name) + "</span></div>" + rows + "</div>";
    }

    // Match facts. Ownership is now DRAFT ownership (the fantasy team that
    // drafted each country), one line per side — there are no groups.
    var facts = "";
    function fact(k, v) { return v ? '<div class="mc-fact"><span>' + k + "</span><b>" + v + "</b></div>" : ""; }
    facts += fact("Kickoff", esc(kickoffFull(fx)));
    facts += fact("Venue", fx.venue ? esc(fx.venue) : "");
    facts += fact("Round", esc(stageLabel(fx)) + (fx.matchNumber ? " · Match " + esc(fx.matchNumber) : ""));
    if (fx.home && fx.home.name) facts += fact("Drafted by · " + esc(fx.home.name), ownerLabel(fx.home));
    if (fx.away && fx.away.name) facts += fact("Drafted by · " + esc(fx.away.name), ownerLabel(fx.away));

    // Upcoming: real betting total from odds.json.
    if (!isDone(fx) && !isLive(fx)) {
      var o = oddsFor(fx);
      if (o && o.line != null) {
        facts += fact("Projected total", o.line + " goals" +
          (o.overUS ? " · O " + esc(o.overUS) + " / U " + esc(o.underUS || "") : ""));
      }
    }
    if (facts) blocks += '<div class="mc-card mc-facts">' + facts + "</div>";

    return blocks || '<div class="mc-note">No stats yet.</div>';
  }

  /* ---------------- Bracket tab ---------------- */

  /* One row in the bracket-slice list: a match's two sides + score, with the
     decided winner highlighted and the current match flagged. */
  function sliceRow(mt, isHere) {
    var hName = (mt.home && mt.home.name) || "TBD";
    var aName = (mt.away && mt.away.name) || "TBD";
    var hFlag = mt.home && mt.home.name ? flagFor(mt.home.name) : "";
    var aFlag = mt.away && mt.away.name ? flagFor(mt.away.name) : "";
    var hWon = mt.winner === "home" ? " win" : "";
    var aWon = mt.winner === "away" ? " win" : "";
    var score = (mt.homeGoals != null && mt.awayGoals != null)
      ? mt.homeGoals + "–" + mt.awayGoals : "vs";
    return '<div class="mc-bk-match' + (isHere ? " here" : "") + '">' +
      '<span class="mc-bk-side' + hWon + '">' + hFlag + " " + esc(hName) + "</span>" +
      '<span class="mc-bk-score">' + esc(score) + "</span>" +
      '<span class="mc-bk-side away' + aWon + '">' + aFlag + " " + esc(aName) + "</span>" +
      "</div>";
  }

  function bracketPanel(fx) {
    var ctx = hubCtx();
    var found = ctx && bracketMatch(ctx, fx.id);
    if (!found) {
      return '<div class="mc-note">Bracket detail unavailable for this match.</div>';
    }
    var rounds = ctx.bracket.rounds || [];
    var round = rounds[found.roundIdx];
    var matchIdx = (round.matches || []).indexOf(found.match);

    // This match's round (the match itself highlighted as "here").
    var thisRoundRows = '<div class="mc-bk-block">' +
      '<div class="mc-bk-round">' + esc(round.label || round.name) +
        '<span class="mc-bk-pts">' + esc(round.points) + " pts</span></div>" +
      sliceRow(found.match, true) +
      "</div>";

    // The winner's destination (next round) for the road-ahead context.
    var next = nextMatch(ctx, found.roundIdx, matchIdx);
    var nextBlock = "";
    if (next) {
      var nextRound = rounds[found.roundIdx + 1];
      nextBlock = '<div class="mc-bk-block">' +
        '<div class="mc-bk-round">Winner advances to ' +
          esc(nextRound.label || nextRound.name) +
          '<span class="mc-bk-pts">' + esc(nextRound.points) + " pts</span></div>" +
        sliceRow(next, false) +
        "</div>";
    } else {
      nextBlock = '<div class="mc-bk-block">' +
        '<div class="mc-bk-round">The Final</div>' +
        '<div class="mc-note">Win this and you lift the trophy. 🏆</div>' +
        "</div>";
    }

    return '<div class="mc-card mc-group">' +
      '<div class="mc-card-h">' +
        ((isLive(fx) || isDone(found.match)) ? '<span class="mc-live-tag">Bracket</span>' : "") +
        "Path through the bracket</div>" +
      thisRoundRows + nextBlock +
      "</div>";
  }

  /* ---------------- overlay shell ---------------- */

  var overlay = null;
  var current = null;

  function close() {
    if (!overlay) return;
    document.removeEventListener("keydown", onKey);
    overlay.parentNode && overlay.parentNode.removeChild(overlay);
    overlay = null;
    current = null;
  }
  function onKey(e) { if (e.key === "Escape") close(); }

  // Finished games open on the goal Timeline; live and upcoming games open on
  // Stats so the (live) win probability is the first thing you see — same as
  // Google's match card during a match.
  function defaultTab(fx) { return isDone(fx) ? "timeline" : "stats"; }

  function renderPanels(fx) {
    return '<div class="mc-panel" data-p="timeline">' + timelinePanel(fx) + "</div>" +
      '<div class="mc-panel" data-p="stats">' + statsPanel(fx) + "</div>" +
      '<div class="mc-panel" data-p="bracket">' + bracketPanel(fx) + "</div>";
  }

  /* The scrollable body (hero + tabs + panels + footer). Extracted so a live
     game can re-render it in place as scores tick in, without rebuilding the
     whole overlay. */
  function sheetInner(fx) {
    return hero(fx) +
      '<div class="mc-tabs" role="tablist">' +
        '<button class="mc-tab" data-t="timeline">Timeline</button>' +
        '<button class="mc-tab" data-t="stats">Stats</button>' +
        '<button class="mc-tab" data-t="bracket">Bracket</button>' +
      "</div>" +
      '<div class="mc-panels">' + renderPanels(fx) + "</div>" +
      '<div class="mc-footlink">' +
        '<a target="_blank" rel="noopener" href="' + Live.googleMatchUrl(fx.home.name, fx.away.name) +
          '">View on Google ↗</a>' +
      "</div>";
  }

  function open(fx) {
    if (!fx) return;
    close();
    current = fx;

    overlay = document.createElement("div");
    overlay.className = "mc-overlay";
    overlay.innerHTML =
      '<div class="mc-sheet" role="dialog" aria-modal="true" aria-label="Match center">' +
        '<div class="mc-bar">' +
          '<button class="mc-back" aria-label="Close">‹</button>' +
          '<span class="mc-bar-title">' + esc(fx.home.name || "TBD") + " vs " + esc(fx.away.name || "TBD") + "</span>" +
          '<button class="mc-close" aria-label="Close">✕</button>' +
        "</div>" +
        '<div class="mc-scroll">' + sheetInner(fx) + "</div>" +
      "</div>";

    setActiveTab(defaultTab(fx));

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || e.target.classList.contains("mc-close") || e.target.classList.contains("mc-back")) {
        close(); return;
      }
      var t = e.target.closest(".mc-tab");
      if (t) setActiveTab(t.getAttribute("data-t"));
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
  }

  /* Re-render the open panel in place from the latest Hub data — keeps a live
     match's score, minute and win probability ticking without the user
     reopening. Preserves the active tab and scroll position. */
  function refreshOpen() {
    if (!overlay || !current) return;
    var fx = fixtureById(current.id);
    if (!fx) return;
    current = fx;
    var scroll = overlay.querySelector(".mc-scroll");
    if (!scroll) return;
    var activeEl = overlay.querySelector(".mc-tab.is-active");
    var active = activeEl ? activeEl.getAttribute("data-t") : defaultTab(fx);
    var top = scroll.scrollTop;
    scroll.innerHTML = sheetInner(fx);
    setActiveTab(active);
    scroll.scrollTop = top;
  }

  function setActiveTab(name) {
    if (!overlay) return;
    overlay.querySelectorAll(".mc-tab").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-t") === name);
    });
    overlay.querySelectorAll(".mc-panel").forEach(function (p) {
      p.classList.toggle("is-active", p.getAttribute("data-p") === name);
    });
  }

  /* Find a fixture in the live Hub context by its id. */
  function fixtureById(id) {
    var ctx = hubCtx();
    if (!ctx || !ctx.allFixtures) return null;
    return ctx.allFixtures.find(function (fx) { return String(fx.id) === String(id); }) || null;
  }

  function openById(id) { open(fixtureById(id)); }

  /* ---------------- boot ---------------- */

  // Import the panel's data up front: recap summaries + goal lists
  // (data/recaps.json) and bookmaker totals (data/odds.json). The score, cards,
  // bracket slice and win probability come from the live Hub context.
  loadRecaps();
  loadOdds();

  // One delegated listener for every [data-mc] trigger (bracket cards + live
  // strip), so it survives the app's full re-renders without re-binding. Opens
  // the in-app Match Center; the panel itself carries a "View on Google ↗" link
  // at the bottom (Live.googleMatchUrl → plain search) for the full Google card.
  document.addEventListener("click", function (e) {
    var trig = e.target.closest && e.target.closest("[data-mc]");
    if (!trig) return;
    e.preventDefault();
    openById(trig.getAttribute("data-mc"));
  });
  // Keyboard activation for the role="button" live-strip cards.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var trig = e.target.closest && e.target.closest('[data-mc][role="button"]');
    if (!trig) return;
    e.preventDefault();
    openById(trig.getAttribute("data-mc"));
  });

  // After each render: refresh recap data, and if a live match's panel is open,
  // re-render it in place so its score, minute and win probability stay live.
  if (window.Hub) Hub.onRender(function (ctx) {
    if (!ctx || !ctx.standings || !ctx.bracket || !ctx.draft) return;
    loadRecaps();
    if (current && isLive(current)) refreshOpen();
  });

  return { open: open, openById: openById };
})();
