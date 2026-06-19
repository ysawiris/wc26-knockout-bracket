/* ============================================================
   RIVALRY — "am I beating <X>?"

   One hub serves the whole league, so this panel is a head-to-head:
   YOUR team (the standings row with team.isMine, picked via
   js/my-team.js) versus a chosen OPPONENT. The default opponent is
   the team directly ahead of you in the table (the one you're
   chasing); if you're already top, it falls back to the team
   directly behind you (the one chasing you).

   For each side it shows the two drafted countries (flag + name),
   each country's live status (alive / out, furthest round reached,
   points banked), the two point totals, the GAP and who leads, and
   each team's "points still on the table" — the round points their
   still-alive countries can yet bank (same logic shape as road.js).
   A plain-English verdict caps it ("You lead Dave by 6 — but he has
   18 still on the table"), plus an opponent <select> to compare
   against any of the other 11 teams and a 📋 copy-the-matchup button.

   Self-contained Hub module: registers Hub.onRender, writes into
   #rivalry-host, re-derives on every refresh. No team claimed → a
   one-tap prompt that opens the team picker.
   ============================================================ */

(function () {
  "use strict";

  var HOST_ID = "rivalry-host";

  /* Sticky opponent choice for the session (survives re-renders). Cleared
     implicitly when it no longer applies (e.g. equals the new "my" team). */
  var pinnedOpponent = null;

  function myTeam() {
    return (window.MyTeam && MyTeam.current && MyTeam.current()) || null;
  }

  /* Knockout totals carry a 0.1/goal bonus, so they can be fractional.
     Trim a trailing ".0" for clean display (mirrors road.js / app.js). */
  function fmtPts(n) {
    var r = Math.round((n || 0) * 10) / 10;
    return (r % 1 === 0) ? String(r) : r.toFixed(1);
  }

  function first(name) { return String(name || "").split(" ")[0]; }

  /* ---------------- per-country derivation from the bracket ----------------
     All of this reads ctx.bracket so it stays in lockstep with the core
     scoring config (round points, ordinals). */

  /* The furthest round a country appears in, whether it's still alive, and
     whether it has already WON that furthest round. Single bracket pass. */
  function countryProgress(ctx, countryId) {
    var rounds = ctx.bracket.rounds || [];
    var playedOrd = 0;      // furthest round ordinal this country is a participant in
    var alive = true;
    var wonFurthest = false; // already won its furthest round
    var goals = 0;           // goals this country has scored across the bracket
    var bankedOrds = {};     // ordinals it has WON (banks those round points)
    rounds.forEach(function (round) {
      round.matches.forEach(function (mt) {
        var isHome = mt.home && mt.home.countryId === countryId;
        var isAway = mt.away && mt.away.countryId === countryId;
        if (!isHome && !isAway) return;
        if (isHome && typeof mt.homeGoals === "number") goals += mt.homeGoals;
        if (isAway && typeof mt.awayGoals === "number") goals += mt.awayGoals;
        if (round.ordinal > playedOrd) {
          playedOrd = round.ordinal;
          wonFurthest = mt.winnerId === countryId;
        }
        if (mt.winnerId === countryId) bankedOrds[round.ordinal] = true;
        if (mt.winnerId && mt.winnerId !== countryId) alive = false;
      });
    });
    return {
      playedOrd: playedOrd, alive: alive, wonFurthest: wonFurthest,
      goals: goals, bankedOrds: bankedOrds
    };
  }

  /* Advancement points a country has already banked: sum of round points for
     every round ordinal it has won. */
  function bankedPointsForCountry(ctx, countryId) {
    var rounds = ctx.bracket.rounds || [];
    var prog = countryProgress(ctx, countryId);
    var sum = 0;
    rounds.forEach(function (round) {
      if (prog.bankedOrds[round.ordinal]) sum += (round.points || 0);
    });
    return sum;
  }

  /* Points a still-alive country could STILL bank: round points for every
     round at/after the furthest it's in (the furthest only if not yet won).
     Eliminated countries contribute 0. Mirrors road.js. */
  function pointsOnTableForCountry(ctx, countryId) {
    var rounds = ctx.bracket.rounds || [];
    var prog = countryProgress(ctx, countryId);
    if (!prog.playedOrd || !prog.alive) return 0;
    var sum = 0;
    rounds.forEach(function (round) {
      if (prog.wonFurthest ? round.ordinal > prog.playedOrd
        : round.ordinal >= prog.playedOrd) {
        sum += (round.points || 0);
      }
    });
    return sum;
  }

  /* A human label for how far a country has got: "Champion" if it won the
     final, otherwise the label of the furthest round it has played, or "—". */
  function reachedLabelForCountry(ctx, countryId) {
    var rounds = ctx.bracket.rounds || [];
    if (!rounds.length) return "—";
    var prog = countryProgress(ctx, countryId);
    if (!prog.playedOrd) return "—";
    var lastOrd = rounds[rounds.length - 1].ordinal;
    if (prog.playedOrd === lastOrd && prog.wonFurthest) return "Champion";
    var label = "—";
    rounds.forEach(function (round) {
      if (round.ordinal === prog.playedOrd) label = round.label || round.name || "—";
    });
    return label;
  }

  /* The full per-country card data for one of a team's drafted countries. */
  function countryCard(ctx, c) {
    var prog = countryProgress(ctx, c.id);
    return {
      id: c.id,
      name: c.name,
      flag: c.flag || "",
      /* Pre-kickoff (no bracket match played) a country is "alive" by default;
         once it has played, alive tracks whether it has lost. */
      alive: prog.playedOrd === 0 ? true : prog.alive,
      started: prog.playedOrd > 0,
      reached: reachedLabelForCountry(ctx, c.id),
      points: bankedPointsForCountry(ctx, c.id),
      goals: prog.goals,
      onTable: pointsOnTableForCountry(ctx, c.id)
    };
  }

  /* ---------------- per-team derivation ---------------- */

  /* The standings row for a team abbr. */
  function rowFor(ctx, abbr) {
    return ctx.standings.find(function (r) {
      return r.team && r.team.abbr === abbr;
    }) || null;
  }

  function deriveSide(ctx, row) {
    var complete = !!(ctx.draft && ctx.draft.complete);
    var drafted = row.drafted || [];
    var cards = complete
      ? drafted.map(function (c) { return countryCard(ctx, c); })
      : [];
    var onTable = 0;
    cards.forEach(function (cc) { onTable += cc.onTable; });
    return {
      team: row.team,
      row: row,
      rank: row.rank,
      points: row.points,
      advancePoints: row.advancePoints,
      goals: row.goals,
      reached: row.reached,
      aliveCount: row.aliveCount,
      cards: cards,
      onTable: onTable
    };
  }

  /* Choose the default opponent for "me": the team one slot ahead (the one
     I'm chasing); if I'm already top, the team one slot behind. */
  function defaultOpponentAbbr(ctx, myAbbr) {
    var st = ctx.standings;
    var idx = st.findIndex(function (r) { return r.team.abbr === myAbbr; });
    if (idx < 0) return null;
    var above = st[idx - 1];
    var below = st[idx + 1];
    if (above) return above.team.abbr;
    if (below) return below.team.abbr;
    return null;
  }

  function derive(ctx, mine) {
    var st = ctx.standings;
    var myRow = rowFor(ctx, mine.abbr);
    if (!myRow) return null;

    /* Resolve the opponent: a valid pinned choice (not me, still in the
       league) wins; otherwise the default. */
    var oppAbbr = null;
    if (pinnedOpponent && pinnedOpponent !== mine.abbr && rowFor(ctx, pinnedOpponent)) {
      oppAbbr = pinnedOpponent;
    } else {
      oppAbbr = defaultOpponentAbbr(ctx, mine.abbr);
    }
    var oppRow = oppAbbr ? rowFor(ctx, oppAbbr) : null;
    if (!oppRow) return null; // 1-team edge case — nothing to compare

    var me = deriveSide(ctx, myRow);
    var opp = deriveSide(ctx, oppRow);

    var complete = !!(ctx.draft && ctx.draft.complete);
    var started = !!ctx.started;
    var gap = me.points - opp.points;

    return {
      ctx: ctx,
      complete: complete,
      started: started,
      me: me,
      opp: opp,
      gap: gap,                       // +ve: I lead; -ve: I trail; 0: level
      lead: gap > 0 ? "me" : gap < 0 ? "opp" : "tie",
      others: st                      // for the <select>
    };
  }

  /* ---------------- verdict line ---------------- */

  function verdictLine(d) {
    var meN = d.me.team.name;
    var oppN = d.opp.team.name;
    if (!d.complete) {
      return "Draft's not locked yet — once everyone picks their two countries, this head-to-head goes live.";
    }
    if (!d.started) {
      return meN + " and " + oppN + " are both level at 0 — " +
        fmtPts(d.me.onTable) + " on the table for you, " + fmtPts(d.opp.onTable) +
        " for them. May the deepest run win.";
    }
    var g = Math.abs(d.gap);
    var oppTable = d.opp.onTable;
    var myTable = d.me.onTable;
    if (d.lead === "tie") {
      return "Dead level with " + oppN + " on " + fmtPts(d.me.points) + " — " +
        (oppTable > 0
          ? "they've still got " + fmtPts(oppTable) + " on the table" +
            (myTable > 0 ? " to your " + fmtPts(myTable) + "." : ", you've got none left.")
          : myTable > 0 ? "you've got " + fmtPts(myTable) + " left, they don't."
            : "and neither of you has anything left to bank.");
    }
    if (d.lead === "me") {
      var tail;
      if (oppTable === 0) {
        tail = first(oppN) + " is out of road — that lead is safe.";
      } else if (oppTable > g) {
        tail = "but " + first(oppN) + " has " + fmtPts(oppTable) +
          " still on the table — one deep run flips it.";
      } else {
        tail = first(oppN) + " has only " + fmtPts(oppTable) + " left to chase with.";
      }
      return "You lead " + first(oppN) + " by " + fmtPts(g) + " — " + tail;
    }
    // I trail
    var tail2;
    if (myTable === 0) {
      tail2 = "and you're out of road — you'd need them to stumble.";
    } else if (myTable > g) {
      tail2 = "but you've got " + fmtPts(myTable) +
        " still on the table — enough to catch them.";
    } else {
      tail2 = "and you've only " + fmtPts(myTable) + " left to close it.";
    }
    return first(oppN) + " leads you by " + fmtPts(g) + " — " + tail2;
  }

  /* ---------------- copy-for-the-chat text ---------------- */

  function sideLine(side, complete, started) {
    var flags = side.cards.length
      ? side.cards.map(function (cc) {
          var st = !started ? "" : cc.alive ? " ✅" : " ❌";
          return cc.flag + " " + cc.name + st;
        }).join(", ")
      : "drafting soon";
    var pts = complete ? " · " + fmtPts(side.points) + " pts" : "";
    var tbl = complete && started && side.onTable > 0
      ? " · " + fmtPts(side.onTable) + " on the table" : "";
    return side.team.name + " (#" + side.rank + ")" + pts + tbl + "\n   " + flags;
  }

  function copyText(d) {
    var lines = [
      "⚔️ " + d.me.team.name + " vs " + d.opp.team.name,
      sideLine(d.me, d.complete, d.started),
      sideLine(d.opp, d.complete, d.started),
      verdictLine(d),
      location.origin + location.pathname + "?team=" + d.me.team.abbr
    ];
    return lines.join("\n");
  }

  /* ---------------- clipboard (mirrors road.js / board-extras) ---------------- */

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

  /* ---------------- render helpers ---------------- */

  function countryRow(cc, esc, complete, started) {
    var status, sCls;
    if (!complete) { status = "drafting"; sCls = "is-pending"; }
    else if (!started || !cc.started) { status = "not started"; sCls = "is-pending"; }
    else if (cc.alive) {
      status = "alive · " + esc(cc.reached);
      sCls = "is-alive";
    } else {
      status = "out · " + esc(cc.reached);
      sCls = "is-out";
    }
    var pts = complete
      ? '<span class="rvc-pts">' + fmtPts(cc.points) + " pts</span>"
      : "";
    return '<div class="rvc ' + sCls + '">' +
      '<span class="rvc-flag">' + (cc.flag || "·") + "</span>" +
      '<span class="rvc-name">' + esc(cc.name) + "</span>" +
      '<span class="rvc-status">' + status + "</span>" +
      pts +
    "</div>";
  }

  function sideColumn(side, cls, esc, ord, complete, started, isLeader) {
    var accent = side.team.accent || "#c89638";
    var cards = side.cards.length
      ? side.cards.map(function (cc) { return countryRow(cc, esc, complete, started); }).join("")
      : '<div class="rvc is-pending"><span class="rvc-flag">·</span>' +
        '<span class="rvc-name">Drafting soon</span></div>';
    var crown = isLeader ? '<span class="rv-crown" title="ahead right now">👑</span>' : "";
    var tableLine = complete && started
      ? '<div class="rv-table">' + fmtPts(side.onTable) + ' <span>on the table</span></div>'
      : "";
    return '<div class="rv-col ' + cls + '" style="--team-accent:' + accent + '">' +
      '<div class="rv-col-head">' +
        '<span class="rv-rank">#' + side.rank + "</span>" +
        '<span class="rv-team">' + esc(side.team.name) + crown + "</span>" +
      "</div>" +
      '<div class="rv-total">' +
        '<span class="rv-total-num">' + (complete ? fmtPts(side.points) : "—") + "</span>" +
        '<span class="rv-total-key">points</span>' +
      "</div>" +
      '<div class="rv-countries">' + cards + "</div>" +
      tableLine +
    "</div>";
  }

  function opponentSelect(d, esc) {
    var myAbbr = d.me.team.abbr;
    var oppAbbr = d.opp.team.abbr;
    var opts = d.others
      .filter(function (r) { return r.team.abbr !== myAbbr; })
      .map(function (r) {
        var sel = r.team.abbr === oppAbbr ? " selected" : "";
        var pts = (d.complete ? " · " + fmtPts(r.points) + " pts" : "");
        return '<option value="' + esc(r.team.abbr) + '"' + sel + ">#" +
          r.rank + " " + esc(r.team.name) + pts + "</option>";
      }).join("");
    return '<label class="rv-select-wrap">' +
      '<span class="rv-select-label">Compare against</span>' +
      '<select class="rv-select" data-rivalry="opponent">' + opts + "</select>" +
    "</label>";
  }

  function gapBadge(d) {
    if (!d.complete) return '<span class="rv-gap rv-gap-tie">draft pending</span>';
    if (d.lead === "tie") {
      return '<span class="rv-gap rv-gap-tie">LEVEL · ' + fmtPts(d.me.points) + " each</span>";
    }
    var g = fmtPts(Math.abs(d.gap));
    var who = d.lead === "me" ? "you lead" : d.ctx.helpers.esc(first(d.opp.team.name)) + " leads";
    var cls = d.lead === "me" ? "rv-gap-me" : "rv-gap-opp";
    return '<span class="rv-gap ' + cls + '">' + who + " by " + g + "</span>";
  }

  /* ---------------- render ---------------- */

  function renderMatchup(host, d) {
    var esc = d.ctx.helpers.esc;
    var ord = d.ctx.helpers.ordinal;

    host.innerHTML =
      '<div class="rivalry-card">' +
        '<div class="rivalry-head">' +
          '<span class="rivalry-eyebrow">⚔️ Rivalry · Am I beating them?</span>' +
          '<button type="button" class="rivalry-team-pill" data-rivalry="switch">🏷 ' +
            esc(d.me.team.name) + ' <span class="rtp-caret">▾</span></button>' +
        "</div>" +
        opponentSelect(d, esc) +
        '<div class="rivalry-versus">' +
          sideColumn(d.me, "rv-me", esc, ord, d.complete, d.started, d.lead === "me") +
          '<div class="rv-vs"><span class="rv-vs-bolt">VS</span>' + gapBadge(d) + "</div>" +
          sideColumn(d.opp, "rv-opp", esc, ord, d.complete, d.started, d.lead === "opp") +
        "</div>" +
        '<div class="rivalry-verdict"><span class="rvv-icon">🎯</span>' +
          '<span class="rvv-text">' + esc(verdictLine(d)) + "</span></div>" +
        '<div class="rivalry-actions">' +
          '<button type="button" class="rivalry-btn primary" data-rivalry="copy">📋 Copy the matchup</button>' +
          '<button type="button" class="rivalry-btn" data-rivalry="board">🏆 See the standings →</button>' +
        "</div>" +
      "</div>";
  }

  function renderEmpty(host) {
    host.innerHTML =
      '<div class="rivalry-card rivalry-empty">' +
        '<span class="rivalry-eyebrow">⚔️ Rivalry · Am I beating them?</span>' +
        '<p class="rivalry-empty-line">Claim your team to unlock the head-to-head — your two ' +
          "countries against any rival's, the live points gap, who leads, and how much each of " +
          "you still has on the table.</p>" +
        '<button type="button" class="rivalry-btn primary" data-rivalry="switch">🏷 Pick your team</button>' +
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
    renderMatchup(host, d);
  }

  /* ---------------- events ---------------- */

  function onClick(e) {
    var btn = e.target.closest("[data-rivalry]");
    if (!btn) return;
    var action = btn.getAttribute("data-rivalry");

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

  function onChange(e) {
    var sel = e.target.closest("[data-rivalry='opponent']");
    if (!sel) return;
    pinnedOpponent = sel.value || null;
    if (window.Hub && Hub.ctx) {
      var ctx = Hub.ctx();
      if (ctx) render(ctx);
    }
  }

  /* ---------------- boot ---------------- */

  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  if (window.Hub && Hub.onRender) Hub.onRender(render);

  window.Rivalry = { render: render };
})();
