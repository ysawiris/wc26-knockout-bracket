/* ============================================================
   ROAD TO YOUR PICK — the viewer's personal race command center.

   One hub serves the whole league, so this panel is all about
   YOUR team (picked via js/my-team.js). It sits at the top of the
   Forecast tab and answers the only question a manager actually
   cares about mid-tournament: "where do I stand, and what do I
   need?" — your draft-slot rank, points back of #1, the cushion on
   the team chasing you, how many knockout rounds your 2 drafted
   countries still have left, the points still on the table, and
   how many of your countries are still alive — plus the model's
   read on your finish (reused straight from window.PickOdds.forecast).

   Self-contained Hub module: registers Hub.onRender, writes into
   #road-host, re-derives on every refresh. No team claimed → a
   one-tap prompt that opens the team picker (and grows adoption
   of the whole hub).
   ============================================================ */

(function () {
  "use strict";

  var HOST_ID = "road-host";

  function myTeam() {
    return (window.MyTeam && MyTeam.current && MyTeam.current()) || null;
  }

  function inplay(st) { return !!(window.Live && Live.INPLAY && Live.INPLAY[st]); }

  /* Best-effort projection from the shared odds engine. Cached there by
     fingerprint, so calling it every render is cheap; null if odds.js
     hasn't loaded or there's nothing to simulate yet. */
  function projectionFor(ctx, abbr) {
    try {
      var fc = window.PickOdds && PickOdds.forecast ? PickOdds.forecast(ctx) : null;
      if (!fc || !fc.rows) return null;
      var row = fc.rows.find(function (r) { return r.abbr === abbr; });
      return row ? { row: row, pre: !!fc.pre } : null;
    } catch (_) { return null; }
  }

  function pct(p) {
    if (p == null) return null;
    if (p <= 0) return "0%";
    if (p < 0.01) return "<1%";
    return Math.round(p * 100) + "%";
  }

  function shareBaseUrl() {
    return location.origin + location.pathname;
  }

  /* Knockout points carry a 0.1/goal bonus, so totals can be fractional.
     Trim a trailing ".0" for clean display (mirrors app.js fmtPts). */
  function fmtPts(n) {
    var r = Math.round((n || 0) * 10) / 10;
    return (r % 1 === 0) ? String(r) : r.toFixed(1);
  }

  /* ---------------- derive everything for one team ---------------- */

  /* Points a single still-alive country could still bank: the round
     points for every round AT OR AFTER the furthest it is currently in
     and still alive. Eliminated countries contribute 0. Reads ctx.bracket
     so it stays in lockstep with the core scoring config. */
  function pointsOnTableForCountry(ctx, countryId) {
    var rounds = ctx.bracket.rounds || [];
    var playedOrd = 0; // furthest round this country appears in as a participant
    var alive = true;
    var wonFurthest = false; // already won its furthest round (no points left there)
    rounds.forEach(function (round) {
      round.matches.forEach(function (mt) {
        var inMatch = (mt.home && mt.home.countryId === countryId) ||
          (mt.away && mt.away.countryId === countryId);
        if (!inMatch) return;
        if (round.ordinal > playedOrd) {
          playedOrd = round.ordinal;
          wonFurthest = mt.winnerId === countryId;
        }
        if (mt.winnerId && mt.winnerId !== countryId) alive = false;
      });
    });
    if (!playedOrd || !alive) return 0;
    /* The furthest round's points are only on the table if it hasn't been won
       yet; once won (e.g. champion winning the Final) that round banks 0 and
       only strictly later rounds count. Everything after is still winnable. */
    var sum = 0;
    rounds.forEach(function (round) {
      if (wonFurthest ? round.ordinal > playedOrd : round.ordinal >= playedOrd) {
        sum += (round.points || 0);
      }
    });
    return sum;
  }

  /* Rounds a still-alive country has left to play: every round after the
     furthest it has appeared in. A country that won the Final has 0. */
  function roundsLeftForCountry(ctx, countryId) {
    var rounds = ctx.bracket.rounds || [];
    var playedOrd = 0;
    var alive = true;
    rounds.forEach(function (round) {
      round.matches.forEach(function (mt) {
        var inMatch = (mt.home && mt.home.countryId === countryId) ||
          (mt.away && mt.away.countryId === countryId);
        if (!inMatch) return;
        if (round.ordinal > playedOrd) playedOrd = round.ordinal;
        if (mt.winnerId && mt.winnerId !== countryId) alive = false;
      });
    });
    if (!alive || !playedOrd) return 0;
    var total = rounds.length; // 5 (R32..Final)
    return Math.max(0, total - playedOrd);
  }

  function derive(ctx, mine) {
    var st = ctx.standings;
    var n = st.length;
    var idx = st.findIndex(function (r) { return r.team.abbr === mine.abbr; });
    if (idx < 0) return null;
    var row = st[idx];
    var leader = st[0];
    var above = st[idx - 1]; // one slot better
    var below = st[idx + 1]; // one slot worse (the chaser)

    var complete = !!(ctx.draft && ctx.draft.complete);
    var started = !!ctx.started;

    /* My two drafted countries (objects with id/name/flag). Empty pre-draft. */
    var drafted = row.drafted || [];

    /* In-play bracket matches that involve one of my countries. */
    var myIds = {};
    drafted.forEach(function (c) { myIds[c.id] = true; });
    var liveFx = (ctx.fixtures || []).filter(function (fx) {
      if (!inplay(fx.status)) return false;
      return (fx.home && myIds[fx.home.countryId]) ||
        (fx.away && myIds[fx.away.countryId]);
    });

    /* Rounds left + points still on the table, summed over my countries. */
    var roundsLeft = 0, pointsOnTable = 0;
    if (complete) {
      drafted.forEach(function (c) {
        roundsLeft = Math.max(roundsLeft, roundsLeftForCountry(ctx, c.id));
        pointsOnTable += pointsOnTableForCountry(ctx, c.id);
      });
    }

    var proj = projectionFor(ctx, mine.abbr);
    var eliminated = complete && started && row.aliveCount === 0;

    return {
      ctx: ctx, team: mine, row: row, n: n,
      complete: complete,
      started: started,
      rank: row.rank,
      points: row.points,
      advancePoints: row.advancePoints,
      goals: row.goals,
      wins: row.wins,
      reached: row.reached,
      aliveCount: row.aliveCount,
      eliminated: eliminated,
      drafted: drafted,
      liveFx: liveFx,
      roundsLeft: roundsLeft,
      pointsOnTable: pointsOnTable,
      amLeader: started && row.rank === 1,
      isLast: row.rank === n,
      pointsBack: leader ? leader.points - row.points : 0,
      leaderName: leader ? leader.team.name : "",
      cushion: below ? row.points - below.points : null,   // points clear of the chaser
      belowName: below ? below.team.name : null,
      climb: above ? above.points - row.points : null,     // points to take the next slot
      aboveName: above ? above.team.name : null,
      tiedTop: started && row.rank === 1 && below ? (row.points === below.points) : false,
      proj: proj
    };
  }

  /* ---------------- status line ---------------- */

  function plural(n, word) { return fmtPts(n) + " " + word + (n === 1 ? "" : "s"); }
  function rounds(n) { return n + (n === 1 ? " round" : " rounds"); }
  function first(name) { return String(name).split(" ")[0]; }

  /* "Argentina & Brazil" from the two drafted countries. */
  function draftedNames(d) {
    var names = d.drafted.map(function (c) { return c.name; });
    if (!names.length) return "your two picks";
    if (names.length === 1) return names[0];
    return names[0] + " & " + names[1];
  }

  function statusLine(d) {
    var T = d.team.name;
    if (!d.complete) {
      return T + "'s race is still on the start line — the snake draft hasn't locked yet. " +
        "You're slotted " + d.rank + d.ctx.helpers.ordinal(d.rank) +
        " in the draft order. Once every team confirms their two countries, the bracket unlocks and points start banking.";
    }
    var who = draftedNames(d);
    if (!d.started) {
      return T + " is locked in with " + who + " — the bracket hasn't kicked off yet, " +
        "so every team sits level at 0. All " + d.ctx.bracket.rounds.length +
        " knockout rounds and every advancement point still up for grabs.";
    }
    if (d.eliminated) {
      return T + " is out — " + who + " have both been knocked out, locking your total at " +
        fmtPts(d.points) + " points (finished " + d.rank + d.ctx.helpers.ordinal(d.rank) +
        (d.reached && d.reached !== "—" ? ", best run to the " + d.reached : "") + ").";
    }
    var lead;
    if (d.amLeader) {
      if (d.tiedTop) {
        lead = T + " tops the table but is dead level with " + d.belowName +
          " on " + fmtPts(d.points) + " points — the next result breaks it.";
      } else if (d.cushion == null) {
        lead = T + " leads the table on " + fmtPts(d.points) + " points.";
      } else {
        lead = T + " leads the table on " + fmtPts(d.points) + " points, " +
          plural(d.cushion, "point") + " clear of " + d.belowName + ".";
      }
    } else {
      lead = T + " sits " + d.rank + d.ctx.helpers.ordinal(d.rank) + " on " +
        fmtPts(d.points) + " points, " + plural(d.pointsBack, "point") + " back of " + d.leaderName +
        (d.pointsBack <= 5 ? " — one deep run flips it." : ".");
    }
    var tail = d.aliveCount === 0
      ? " Both your countries are done."
      : d.aliveCount === 1
        ? " One country still alive with " + rounds(d.roundsLeft) + " to play."
        : " Both countries alive with up to " + rounds(d.roundsLeft) + " still to play.";
    return lead + tail;
  }

  function projLine(d) {
    if (!d.proj) return null;
    var r = d.proj.row;
    var ord = d.ctx.helpers.ordinal;
    var ep = Math.round(r.expSlot);
    return "Model read: " + pct(r.probs[0]) + " shot at the No. 1 slot, projected to finish ~" +
      ep + ord(ep) + (d.proj.pre ? " (preseason, strength-based)." : ".");
  }

  /* ---------------- "what you need" — the actionable read ---------------- */

  function needLine(d) {
    if (!d.complete) {
      return "Lock in the draft to start your knockout run — your two countries bank points each round they advance (R32 win = 3, up to 21 for the Final).";
    }
    if (!d.started) {
      return "Bracket's loaded — your two countries can bank up to " + fmtPts(d.pointsOnTable) +
        " points across the knockout rounds. Most advancement points wins the No. 1 slot.";
    }
    if (d.eliminated) {
      return "Both countries are out — your race is run at " + fmtPts(d.points) +
        " points. Watch the chasers below you.";
    }
    var ord = d.ctx.helpers.ordinal;
    if (d.amLeader) {
      if (d.tiedTop) return "Dead level on top — the next advance decides the slot. Win a round and pull clear.";
      if (d.cushion == null) return "Out front with the No. 1 slot — keep your countries advancing and it's yours.";
      return "Hold your " + plural(d.cushion, "point") + " cushion over " + first(d.belowName) +
        " — you still have " + fmtPts(d.pointsOnTable) + " points on the table to grow it.";
    }
    var target;
    if (d.climb == null || !d.aboveName) {
      target = "every advance tightens the race";
    } else if (d.climb === 0) {
      target = "you're level with " + first(d.aboveName) + " for " + (d.rank - 1) + ord(d.rank - 1) +
        " — one advance breaks the tie";
    } else {
      target = plural(d.climb, "point") + " grabs " + (d.rank - 1) + ord(d.rank - 1) +
        " off " + first(d.aboveName);
    }
    var chase = d.pointsBack === 0
      ? "you're level with " + first(d.leaderName) + " on points for the top slot"
      : plural(d.pointsBack, "point") + " behind " + first(d.leaderName) + " for No. 1";
    return target + "; " + chase + " — " + fmtPts(d.pointsOnTable) + " points still on the table.";
  }

  /* ---------------- copy-for-the-chat text ---------------- */

  function copyText(d) {
    var line2;
    if (!d.complete) {
      line2 = "🧮 Draft slot " + d.rank + " — bracket locks once everyone picks";
    } else if (!d.started) {
      line2 = "🟢 Level at 0 — " + draftedNames(d) + " drafted, bracket about to kick off";
    } else if (d.eliminated) {
      line2 = "🪦 Out — finished " + d.rank + d.ctx.helpers.ordinal(d.rank) + " on " + fmtPts(d.points) + " pts";
    } else if (d.amLeader) {
      line2 = "👑 Leads on " + fmtPts(d.points) + " pts" +
        (d.cushion != null ? " (+" + fmtPts(d.cushion) + " on " + first(d.belowName) + ")" : "");
    } else {
      line2 = d.rank + d.ctx.helpers.ordinal(d.rank) + " · " + fmtPts(d.points) + " pts · " +
        plural(d.pointsBack, "point") + " back of " + d.leaderName;
    }
    var line3;
    if (!d.complete) {
      line3 = "Drafting soon";
    } else if (d.eliminated) {
      line3 = "Both countries knocked out";
    } else {
      line3 = d.aliveCount + (d.aliveCount === 1 ? " country" : " countries") + " alive · " +
        rounds(d.roundsLeft) + " left · " + fmtPts(d.pointsOnTable) + " pts on the table";
    }
    var lines = [
      "🏆 " + d.team.name + " — Road to the No. 1 pick",
      line2,
      line3
    ];
    if (d.proj) {
      var ep = Math.round(d.proj.row.expSlot);
      lines.push("Model: " + pct(d.proj.row.probs[0]) + " for #1 · projected ~" + ep + d.ctx.helpers.ordinal(ep));
    }
    lines.push(shareBaseUrl() + "?team=" + d.team.abbr);
    return lines.join("\n");
  }

  /* ---------------- clipboard (mirrors board-extras) ---------------- */

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
    }
    return fallbackCopy(text);
  }
  function fallbackCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }

  /* ---------------- render ---------------- */

  function metric(val, key, cls) {
    return '<div class="rm' + (cls ? " " + cls : "") + '">' +
      '<span class="rm-val">' + val + "</span>" +
      '<span class="rm-key">' + key + "</span></div>";
  }

  /* Four glanceable tiles. Pre-draft / pre-kickoff they describe the open race
     instead of a "X back of No. 1" gap that doesn't mean anything yet. */
  function metricsFor(d, esc) {
    if (!d.complete) {
      var m4p = d.proj
        ? metric(pct(d.proj.row.probs[0]), "model: shot at No. 1")
        : metric("open", "race wide open");
      return metric("#" + d.rank, "your draft slot") +
        metric(d.ctx.bracket.rounds.length, "knockout rounds") +
        metric("0", "points — all level") +
        m4p;
    }
    if (!d.started) {
      var m4pre = d.proj
        ? metric(pct(d.proj.row.probs[0]), "model: shot at No. 1")
        : metric(fmtPts(d.pointsOnTable), "points on the table");
      return metric("#" + d.rank, "your draft slot") +
        metric("0", "points — all level") +
        metric(d.ctx.bracket.rounds.length, "rounds to play") +
        m4pre;
    }
    if (d.eliminated) {
      return metric(fmtPts(d.points), "final points", "is-out") +
        metric(d.rank + esc(d.ctx.helpers.ordinal(d.rank)), "final place") +
        metric("0", "countries alive") +
        metric(d.reached && d.reached !== "—" ? esc(d.reached) : "—", "best run");
    }
    var m1 = d.amLeader
      ? metric("👑", "you hold No. 1", "is-crown")
      : metric(fmtPts(d.pointsBack), "points back of No. 1");
    var m2;
    if (d.isLast && d.climb != null) m2 = metric(fmtPts(d.climb), "points to climb a spot");
    else if (d.cushion != null) m2 = metric("+" + fmtPts(d.cushion), "cushion on " + esc(first(d.belowName)));
    else m2 = metric("—", "no chaser");
    var m3 = metric(d.aliveCount, d.aliveCount === 1 ? "country alive" : "countries alive");
    var m4 = metric(fmtPts(d.pointsOnTable), "points on the table");
    return m1 + m2 + m3 + m4;
  }

  function liveStrip(d, esc) {
    if (!d.liveFx.length) return "";
    var items = d.liveFx.map(function (fx) {
      var score = (fx.homeGoals != null && fx.awayGoals != null) ? fx.homeGoals + "–" + fx.awayGoals : "vs";
      var min = fx.minute ? ' <span class="rl-min">' + esc(fx.minute) + "</span>" : "";
      var rd = fx.roundLabel ? ' <span class="rl-rd">' + esc(fx.roundLabel) + "</span>" : "";
      return '<span class="rl-item">' + (fx.home.flag || "") + " " + esc(fx.home.name || "TBD") +
        ' <b>' + score + "</b> " + esc(fx.away.name || "TBD") + " " + (fx.away.flag || "") + min + rd + "</span>";
    }).join("");
    return '<div class="road-live"><span class="rl-dot"></span><span class="rl-tag">Your country, live now</span>' + items + "</div>";
  }

  function projTrack(d) {
    if (!d.proj) return "";
    var r = d.proj.row, n = d.n, ord = d.ctx.helpers.ordinal;
    var pos = function (pick) { return ((pick - 1) / (n - 1)) * 100; };
    var ep = Math.round(r.expSlot);
    var bandL = pos(r.lo), bandW = pos(r.hi) - pos(r.lo);
    var head = d.started ? "Projected points finish" : "Preseason projection";
    return '<div class="road-proj">' +
      '<div class="rp-head">' + head + ' <b>~' + ep + ord(ep) + "</b>" +
        '<span class="rp-range">likely ' + r.lo + (r.lo !== r.hi ? "–" + r.hi : "") + "</span></div>" +
      '<div class="rp-track">' +
        '<div class="rp-band" style="left:' + bandL + "%;width:" + Math.max(bandW, 2) + '%"></div>' +
        (d.started ? '<div class="rp-now" style="left:' + pos(d.rank) + '%" title="where you are now"></div>' : "") +
        '<div class="rp-exp" style="left:' + pos(ep) + '%" title="projected finish"></div>' +
      "</div>" +
      '<div class="rp-scale"><span>No. 1</span><span>No. ' + n + "</span></div>" +
      '<div class="rp-legend">' +
        (d.started ? '<span class="rp-k rp-k-now">Now</span>' : "") +
        '<span class="rp-k rp-k-exp">Projected</span>' +
        '<span class="rp-k rp-k-band">Likely range</span>' +
      "</div>" +
    "</div>";
  }

  function renderTeam(host, d) {
    var esc = d.ctx.helpers.esc;
    var ord = d.ctx.helpers.ordinal;
    var accent = d.team.accent || "#c89638";

    var flags = d.drafted.length
      ? d.drafted.map(function (c) { return (c.flag || "") + " " + esc(c.name); }).join(" · ")
      : "Drafting soon";
    var rankNum = d.rank;
    var rankOrd = ord(d.rank);
    var rankLabel = !d.complete ? "your draft slot"
      : !d.started ? "draft slot"
        : d.eliminated ? "final place"
          : "your slot";

    var pl = projLine(d);

    host.innerHTML =
      '<div class="road-card' + (d.eliminated ? " is-eliminated" : "") + '" style="--team-accent:' + accent + '">' +
        '<div class="road-head">' +
          '<span class="road-eyebrow">🛣 Road to No. 1</span>' +
          '<button type="button" class="road-team-pill" data-road="switch">🏷 ' +
            esc(d.team.name) + ' <span class="rtp-caret">▾</span></button>' +
        "</div>" +
        liveStrip(d, esc) +
        '<div class="road-top">' +
          '<div class="road-rank' + (d.amLeader ? " is-first" : "") +
            (d.eliminated ? " is-out" : "") + '">' +
            '<span class="rr-num">' + rankNum + "</span>" +
            '<span class="rr-ord">' + rankOrd + "</span>" +
            '<span class="rr-label">' + rankLabel + "</span>" +
          "</div>" +
          '<div class="road-status">' +
            '<p class="road-line">' + esc(statusLine(d)) + "</p>" +
            (pl ? '<p class="road-proj-line">' + esc(pl) + "</p>" : "") +
            '<div class="road-group">Your countries <span class="rg-flags">' + flags + "</span></div>" +
          "</div>" +
        "</div>" +
        '<div class="road-metrics">' + metricsFor(d, esc) + "</div>" +
        '<div class="road-need"><span class="rn-icon">🎯</span><span class="rn-text">' + esc(needLine(d)) + "</span></div>" +
        projTrack(d) +
        '<div class="road-actions">' +
          '<button type="button" class="road-btn primary" data-road="copy">📋 Copy my status</button>' +
          '<button type="button" class="road-btn" data-road="board">🏆 See the standings →</button>' +
        "</div>" +
      "</div>";
  }

  function renderEmpty(host) {
    host.innerHTML =
      '<div class="road-card road-empty">' +
        '<span class="road-eyebrow">🛣 Road to No. 1</span>' +
        '<p class="road-empty-line">Claim your team to unlock your personal race to the No. 1 pick — ' +
          "your points gap to the lead, the cushion on the team chasing you, rounds left for your two countries, " +
          "and the model's read on your finish.</p>" +
        '<button type="button" class="road-btn primary" data-road="switch">🏷 Pick your team</button>' +
      "</div>";
  }

  /* ---------------- main render ---------------- */

  var lastDerived = null;

  function render(ctx) {
    if (!ctx || !ctx.standings || !ctx.bracket || !ctx.draft) return;
    var host = document.getElementById(HOST_ID);
    if (!host) return;
    var mine = myTeam();
    if (!mine) { lastDerived = null; renderEmpty(host); return; }
    var d = derive(ctx, mine);
    if (!d) { lastDerived = null; host.textContent = ""; return; }
    lastDerived = d;
    renderTeam(host, d);
  }

  /* ---------------- actions ---------------- */

  function onClick(e) {
    var btn = e.target.closest("[data-road]");
    if (!btn) return;
    var action = btn.getAttribute("data-road");

    if (action === "switch") {
      if (window.MyTeam && MyTeam.open) MyTeam.open();
      return;
    }
    if (action === "board") {
      if (window.Hub && Hub.setTab) Hub.setTab("board");
      return;
    }
    if (action === "copy" && lastDerived) {
      writeClipboard(copyText(lastDerived)).then(function () {
        if (btn.getAttribute("data-flashing")) return;
        btn.setAttribute("data-flashing", "1");
        var original = btn.textContent;
        btn.textContent = "Copied ✓";
        btn.classList.add("is-copied");
        setTimeout(function () {
          btn.textContent = original;
          btn.classList.remove("is-copied");
          btn.removeAttribute("data-flashing");
        }, 1600);
      }).catch(function () {});
    }
  }

  /* ---------------- boot ---------------- */

  document.addEventListener("click", onClick);
  if (window.Hub && Hub.onRender) Hub.onRender(render);

  window.RoadTo1 = { render: render };
})();
