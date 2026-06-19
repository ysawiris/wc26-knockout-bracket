/* ============================================================
   ORCHESTRATOR — WC26 Knockout Pool ("The Longest Yard").

   Owns the draft GATE, the core tabs (Draft Order, Snake Draft,
   Bracket, Standings), the live strip, the hero meta, and the
   window.Hub contract that every feature module reads.

   State is the single source of truth in store.js (localStorage
   "wc26ko.v3"). This file renders it, writes back through small
   immutable updaters, rebuilds ctx, and fires Hub.onRender. The
   onRender try/catch keeps not-yet-ported feature modules from
   crashing the core.

   Plain ES5 browser JS — var/function, no build step.
   ============================================================ */

(function () {
  "use strict";

  var state = loadState();
  var activeTab = "draft-order";

  /* Tabs reachable BEFORE the draft completes. Everything else is
     locked behind the gate. */
  var SETUP_TABS = { "draft-order": true, "snake": true, "rules": true };
  function isLockedTab(tab) {
    return !SETUP_TABS[tab] && !draftComplete(state);
  }

  /* Immutable shallow merge — never mutates `base`. */
  function merge(base, patch) {
    return Object.assign({}, base, patch);
  }

  /* ---------------- helpers (kept + new) ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined && html !== null) n.innerHTML = html;
    return n;
  }
  function ordinal(n) {
    var m = n % 100;
    if (m >= 11 && m <= 13) return "th";
    return { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  }

  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function fxDate(fx) {
    if (fx.utcDate) { var d = new Date(fx.utcDate); if (!isNaN(d)) return d; }
    if (!fx.dateISO) return new Date();
    var p = fx.dateISO.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
  }
  function dayKey(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  function fmtDay(d) { return DOW[d.getDay()] + " · " + MON[d.getMonth()] + " " + d.getDate(); }
  function fmtTime(fx) {
    if (!fx.utcDate) return null;
    var d = new Date(fx.utcDate);
    if (isNaN(d)) return null;
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function statusInfo(fx) {
    var s = fx.status;
    if (Live.INPLAY[s]) {
      var label = s === "PAUSED" || s === "HALFTIME" ? "HALF-TIME"
        : "LIVE" + (fx.minute ? " · " + fx.minute : "");
      return { key: "live", label: label, live: true };
    }
    if (Live.FINISHED[s]) return { key: "ft", label: "Full-time", done: true };
    if (s === "POSTPONED" || s === "SUSPENDED" || s === "CANCELLED") {
      return { key: "off", label: s.charAt(0) + s.slice(1).toLowerCase() };
    }
    return { key: "up", label: "Upcoming", upcoming: true };
  }

  function crestHtml(team) {
    var lenCls = team.abbr.length >= 4 ? " len4" : team.abbr.length <= 1 ? " len1" : "";
    var inner = team.photo
      ? '<img src="' + esc(team.photo) + '" alt="' + esc(team.name) + '" ' +
        "onerror=\"this.replaceWith(Object.assign(document.createElement('span'),{className:'mono',textContent:'" + esc(team.abbr) + "'}))\" />"
      : '<span class="mono">' + esc(team.abbr) + "</span>";
    var bg = team.accent ? ' style="background:radial-gradient(circle at 32% 28%, ' + team.accent + ', #140d05)"' : "";
    return '<div class="crest' + lenCls + '"' + bg + ">" + inner + "</div>";
  }

  /* NEW knockout helpers (exposed on ctx.helpers). They lean on the
     current `state`, which is exactly the state ctx was built from. */
  function ownerByCountry() { return ownersByCountry(state); }
  function countryTeamOwner(countryId) { return ownersByCountry(state)[countryId] || null; }
  function countryById(countryId) { return COUNTRY_BY_ID[countryId] || null; }
  function roundLabel(roundKey) {
    for (var i = 0; i < ROUNDS.length; i++) {
      if (ROUNDS[i].key === roundKey) return ROUNDS[i].label;
    }
    return roundKey;
  }
  /* Points one country earned across all rounds, from a teamScores map. */
  function advancePoints(country, scores) {
    if (!country) return 0;
    var sc = (scores || teamScores(state))[country.id];
    return sc ? sc.advance : 0;
  }
  /* Per-team knockout summary (mirrors a standings row's numeric slice). */
  function teamKnockoutPoints(team) {
    var rows = standings(state);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].team && rows[i].team.abbr === team.abbr) {
        var r = rows[i];
        return {
          advancePoints: r.advancePoints, goals: r.goals, points: r.points,
          wins: r.wins, reached: r.reached, aliveCount: r.aliveCount
        };
      }
    }
    return { advancePoints: 0, goals: 0, points: 0, wins: 0, reached: "—", aliveCount: 0 };
  }
  /* Kept name for module compat — re-derives standings rows. */
  function buildStandings() { return standings(state); }

  /* seasonStarted: bracket has >=1 IN_PLAY / FINISHED match. NO GROUPS
     branch (knockout reads FIELD/bracket only). */
  function seasonStarted(rounds) {
    return rounds.some(function (round) {
      return round.matches.some(function (mt) {
        return Live.INPLAY[mt.status] || Live.FINISHED[mt.status];
      });
    });
  }

  /* Trim trailing ".0" off the goal-bonus decimal for display. */
  function fmtPts(n) {
    var r = Math.round(n * 10) / 10;
    return (r % 1 === 0) ? String(r) : r.toFixed(1);
  }

  /* ---------------- toast ---------------- */

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    void t.offsetWidth; // reflow so the show transition restarts on rapid toasts
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove("show");
      setTimeout(function () { t.hidden = true; }, 250);
    }, 1900);
  }

  /* ---------------- state commit ---------------- */

  /* Apply an immutable next-state, persist, detect the gate flip, and
     re-render everything (rebuilding ctx + firing module callbacks). */
  function commit(next) {
    var wasComplete = draftComplete(state);
    state = next;
    saveState(state);
    var nowComplete = draftComplete(state);
    if (!wasComplete && nowComplete) {
      activeTab = "recap";
      toast("🔓 Draft complete — hub unlocked");
    } else if (wasComplete && !nowComplete) {
      /* Draft re-opened (picks cleared) — back to the setup flow. */
      activeTab = "snake";
    }
    renderAll();
    setTab(activeTab, { noScroll: true });
  }

  /* ---------------- TAB: Draft Order ---------------- */

  function renderDraftOrder() {
    var host = document.getElementById("draft-order-host");
    if (!host) return;
    host.textContent = "";
    var hint = document.getElementById("draft-order-hint");
    if (hint) {
      hint.textContent = "Seed the snake draft — top of the list picks first. " +
        "Reorder with the arrows, or flip the whole order.";
    }

    if (state.pickLog.length) {
      host.appendChild(el("div", "notice",
        "⚠︎ Draft has started — reordering now reshuffles who picked what. " +
        "Reset the draft (Snake Draft tab) first for a clean reorder."));
    }

    var list = el("ol", "do-list");
    state.draftOrder.forEach(function (abbr, i) {
      var t = TEAM_BY_ABBR[abbr] || { abbr: abbr, name: abbr, managers: [] };
      var li = el("li", "do-row");
      li.style.setProperty("--ac", t.accent || "#888");
      var sub = (t.managers && t.managers.length)
        ? esc(t.managers.join(" & "))
        : (t.record ? "last season " + esc(t.record) : "");
      li.innerHTML =
        '<span class="do-rank">' + (i + 1) + "</span>" +
        crestHtml(t) +
        '<span class="do-meta"><strong>' + esc(t.name) + "</strong>" +
        '<small>' + sub + "</small></span>" +
        '<span class="do-ctrl">' +
          '<button class="do-mini" type="button" data-move="up" data-idx="' + i + '"' +
            (i === 0 ? " disabled" : "") + ' aria-label="Move up">▲</button>' +
          '<button class="do-mini" type="button" data-move="down" data-idx="' + i + '"' +
            (i === state.draftOrder.length - 1 ? " disabled" : "") + ' aria-label="Move down">▼</button>' +
        "</span>";
      list.appendChild(li);
    });
    host.appendChild(list);

    list.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-move]");
      if (!btn || btn.disabled) return;
      var i = parseInt(btn.getAttribute("data-idx"), 10);
      var j = btn.getAttribute("data-move") === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= state.draftOrder.length) return;
      var nextOrder = state.draftOrder.slice();
      var tmp = nextOrder[i]; nextOrder[i] = nextOrder[j]; nextOrder[j] = tmp;
      commit(merge(state, { draftOrder: nextOrder }));
    });

    var actions = el("div", "do-actions");
    var flip = el("button", "do-btn", "⇅ Flip best-first / worst-first");
    flip.addEventListener("click", function () {
      commit(merge(state, { draftOrder: state.draftOrder.slice().reverse() }));
      toast("Draft order flipped");
    });
    actions.appendChild(flip);
    host.appendChild(actions);
  }

  /* ---------------- TAB: Snake Draft ---------------- */

  function renderSnakeDraft() {
    var host = document.getElementById("snake-host");
    if (!host) return;
    host.textContent = "";

    var seq = pickSequence(state);
    var picker = currentPicker(state);
    var done = draftComplete(state);
    var hint = document.getElementById("snake-hint");
    if (hint) {
      hint.textContent = "2 countries each · snake order gives everyone one earlier (stronger) " +
        "and one later (weaker) pick. " + state.pickLog.length + " / " + seq.length + " picks made.";
    }

    /* On the clock */
    var clock = el("div", "sd-clock" + (done ? " done" : ""));
    if (done) {
      clock.innerHTML = "✓ Draft complete — the hub is unlocked. Head to Standings or the Bracket.";
    } else {
      var p = TEAM_BY_ABBR[picker] || { name: picker, accent: "#888" };
      var roundNo = Math.floor(state.pickLog.length / state.draftOrder.length) + 1;
      var pickNo = state.pickLog.length + 1;
      clock.style.setProperty("--ac", p.accent || "#888");
      clock.innerHTML =
        '<span class="sd-tag">ON THE CLOCK · pick ' + pickNo + " of " + seq.length +
          " (rd " + roundNo + ")</span>" +
        "<strong>" + esc(p.name) + "</strong>" +
        '<small>pick a country below — they take the snake’s ' +
        (roundNo % 2 === 1 ? "early" : "late") + " slot</small>";
    }
    host.appendChild(clock);

    var actions = el("div", "sd-actions");
    var auto = el("button", "sd-btn", "⚡ Auto-pick best available");
    auto.disabled = done;
    auto.addEventListener("click", function () { makePick(bestAvailableId()); });
    var fill = el("button", "sd-btn", "🎲 Auto-fill rest of draft");
    fill.disabled = done;
    fill.addEventListener("click", autoFillDraft);
    var undo = el("button", "sd-btn-ghost", "↶ Undo last pick");
    undo.disabled = state.pickLog.length === 0;
    undo.addEventListener("click", function () {
      commit(merge(state, { pickLog: state.pickLog.slice(0, -1) }));
    });
    var reset = el("button", "sd-btn-ghost", "↺ Reset draft");
    reset.disabled = state.pickLog.length === 0;
    reset.addEventListener("click", function () {
      if (!confirm("Clear all draft picks? (Bracket results stay.)")) return;
      commit(merge(state, { pickLog: [] }));
      toast("Draft reset");
    });
    actions.appendChild(auto); actions.appendChild(fill);
    actions.appendChild(undo); actions.appendChild(reset);
    host.appendChild(actions);

    var cols = el("div", "sd-cols");

    /* Available pool (left) */
    var avail = availableCountries(state);
    var pool = el("div", "sd-pool");
    pool.appendChild(el("h3", "sd-colhead", "Available (" + avail.length + ")"));
    var grid = el("div", "sd-pool-grid");
    avail.forEach(function (c) {
      var b = el("button", "sd-country");
      b.setAttribute("data-country", c.id);
      b.disabled = done;
      b.style.setProperty("--tc", c.c1 || "#888");
      b.innerHTML =
        '<span class="sdc-seed">#' + c.seed + "</span>" +
        '<span class="sdc-flag">' + c.flag + "</span>" +
        '<span class="sdc-name">' + esc(c.name) + "</span>";
      grid.appendChild(b);
    });
    pool.appendChild(grid);
    grid.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-country]");
      if (b && !b.disabled) makePick(b.getAttribute("data-country"));
    });
    cols.appendChild(pool);

    /* Rosters (right) */
    var byTeam = countriesByTeam(state);
    var rosters = el("div", "sd-rosters");
    rosters.appendChild(el("h3", "sd-colhead", "Rosters"));
    state.draftOrder.forEach(function (abbr) {
      var t = TEAM_BY_ABBR[abbr] || { abbr: abbr, name: abbr, accent: "#888" };
      var card = el("div", "sd-roster" + (abbr === picker ? " on-clock" : ""));
      card.style.setProperty("--ac", t.accent || "#888");
      var ids = byTeam[abbr] || [];
      var body = "";
      for (var k = 0; k < 2; k++) {
        var id = ids[k];
        if (id) {
          var c = COUNTRY_BY_ID[id];
          body += '<span class="sd-rt" style="--tc:' + (c.c1 || "#888") + '">' +
            c.flag + " " + esc(c.name) + ' <em>#' + c.seed + "</em></span>";
        } else {
          body += '<span class="sd-rt empty">— slot ' + (k + 1) + "</span>";
        }
      }
      card.innerHTML =
        '<div class="sd-roster-head"><span class="sd-rabbr">' + esc(abbr) + "</span>" +
        '<span class="sd-rname">' + esc(t.name) + "</span></div>" +
        '<div class="sd-roster-teams">' + body + "</div>";
      rosters.appendChild(card);
    });
    cols.appendChild(rosters);
    host.appendChild(cols);
  }

  function bestAvailableId() {
    var av = availableCountries(state);
    if (!av.length) return null;
    av.sort(function (a, b) { return a.seed - b.seed; });
    return av[0].id;
  }
  function makePick(countryId) {
    if (!countryId || draftComplete(state)) return;
    if (state.pickLog.indexOf(countryId) !== -1) return;
    commit(merge(state, { pickLog: state.pickLog.concat([countryId]) }));
  }
  function autoFillDraft() {
    var log = state.pickLog.slice();
    var total = totalPicks(state);
    var taken = {};
    log.forEach(function (id) { taken[id] = true; });
    var pool = FIELD.slice().sort(function (a, b) { return a.seed - b.seed; });
    while (log.length < total) {
      var next = null;
      for (var i = 0; i < pool.length; i++) {
        if (!taken[pool[i].id]) { next = pool[i].id; break; }
      }
      if (!next) break;
      taken[next] = true;
      log.push(next);
    }
    commit(merge(state, { pickLog: log }));
  }

  /* ---------------- TAB: Draft Recap (post-draft) ---------------- */

  /* Replaces the Draft Order + Snake Draft tabs once all picks are in:
     a read-only summary of how the snake draft went. */
  function renderRecap() {
    var host = document.getElementById("recap-host");
    if (!host) return;
    host.textContent = "";
    var hint = document.getElementById("recap-hint");

    if (!draftComplete(state)) {
      if (hint) hint.textContent = "";
      host.appendChild(el("p", "panel-hint", "The recap appears once all picks are in."));
      return;
    }

    var seq = pickSequence(state);
    var byTeam = countriesByTeam(state);
    var n = state.draftOrder.length;
    var dir = (state.config && state.config.draftDirection === "worst-first")
      ? "worst-to-first" : "best-to-first";
    if (hint) {
      hint.textContent = seq.length + " picks · " + n + " teams · snake order (" + dir +
        "). The board is set — here's how it went.";
    }

    /* --- Each team's two (strong + weak), in draft-slot order --- */
    host.appendChild(el("h3", "rc-subhead", "Each team's two"));
    var grid = el("div", "rc-rosters");
    state.draftOrder.forEach(function (abbr, i) {
      var t = TEAM_BY_ABBR[abbr] || { abbr: abbr, name: abbr, accent: "#888" };
      var ids = byTeam[abbr] || [];
      var card = el("div", "rc-roster");
      card.style.setProperty("--ac", t.accent || "#888");
      var teamsHtml = ids.map(function (id) {
        var c = COUNTRY_BY_ID[id];
        if (!c) return "";
        return '<span class="rc-rt" style="--tc:' + (c.c1 || "#888") + '">' +
          '<span class="rc-rt-flag">' + c.flag + "</span>" + esc(c.name) +
          ' <em>#' + c.seed + "</em></span>";
      }).join("");
      card.innerHTML =
        '<span class="rc-slot">' + (i + 1) + "</span>" +
        '<div class="rc-roster-mid">' +
          '<div class="rc-roster-head"><span class="rc-rabbr">' + esc(abbr) + "</span>" +
          '<span class="rc-rname">' + esc(t.name) + "</span></div>" +
          '<div class="rc-roster-teams">' + teamsHtml + "</div></div>";
      grid.appendChild(card);
    });
    host.appendChild(grid);

    /* --- Pick by pick (the snake order) --- */
    host.appendChild(el("h3", "rc-subhead", "Pick by pick"));
    var rounds = Math.ceil(seq.length / n);
    var picks = el("div", "rc-picks");
    for (var r = 0; r < rounds; r++) {
      var col = el("div", "rc-round");
      col.appendChild(el("div", "rc-round-head",
        "Round " + (r + 1) + (r === 0 ? " · the stronger picks" : " · the weaker picks")));
      var list = el("ol", "rc-pick-list");
      for (var p = r * n; p < Math.min((r + 1) * n, seq.length); p++) {
        var pAbbr = seq[p];
        var c = COUNTRY_BY_ID[state.pickLog[p]];
        var pt = TEAM_BY_ABBR[pAbbr] || { name: pAbbr, accent: "#888" };
        var li = el("li", "rc-pick");
        li.style.setProperty("--ac", pt.accent || "#888");
        li.innerHTML =
          '<span class="rc-pno">' + (p + 1) + "</span>" +
          '<span class="rc-pteam">' + esc(pt.name) + "</span>" +
          '<span class="rc-pcountry">' +
            (c ? c.flag + " " + esc(c.name) + ' <em>#' + c.seed + "</em>" : "—") + "</span>";
        list.appendChild(li);
      }
      col.appendChild(list);
      picks.appendChild(col);
    }
    host.appendChild(picks);

    /* --- Actions --- */
    var actions = el("div", "rc-actions");
    var copyBtn = el("button", "sd-btn", "📋 Copy the draft");
    copyBtn.addEventListener("click", function () { copyRecap(byTeam); });
    var reopen = el("button", "sd-btn-ghost", "↺ Re-open draft");
    reopen.addEventListener("click", function () {
      if (!confirm("Re-open the draft? This clears all picks and re-locks the hub.")) return;
      commit(merge(state, { pickLog: [] }));
      toast("Draft re-opened");
    });
    actions.appendChild(copyBtn);
    actions.appendChild(reopen);
    host.appendChild(actions);
  }

  function copyRecap(byTeam) {
    var lines = ["🐍 The Longest Yard — DRAFT RECAP"];
    state.draftOrder.forEach(function (abbr, i) {
      var t = TEAM_BY_ABBR[abbr] || { name: abbr };
      var cs = (byTeam[abbr] || []).map(function (id) {
        var c = COUNTRY_BY_ID[id];
        return c ? c.flag + " " + c.name : "";
      }).join(" + ");
      lines.push((i + 1) + ". " + t.name + " — " + cs);
    });
    var text = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast("Draft recap copied ✓"); },
        function () { toast("Copy failed"); }
      );
    } else {
      toast("Copy not supported here");
    }
  }

  /* ---------------- TAB: Bracket ---------------- */

  function renderBracket() {
    var host = document.getElementById("bracket-host");
    if (!host) return;
    host.textContent = "";

    var owners = ownersByCountry(state);
    var rounds = buildBracket(state);
    var wrap = el("div", "bk");

    rounds.forEach(function (round) {
      var col = el("div", "bk-col");
      col.appendChild(el("div", "bk-round", esc(round.label)));
      var matches = el("div", "bk-matches");
      round.matches.forEach(function (mt) {
        matches.appendChild(bracketMatchEl(mt, owners));
      });
      col.appendChild(matches);
      wrap.appendChild(col);
    });
    host.appendChild(wrap);

    var champ = champion(state);
    if (champ && COUNTRY_BY_ID[champ]) {
      var c = COUNTRY_BY_ID[champ];
      var owner = owners[champ];
      var ot = owner ? TEAM_BY_ABBR[owner] : null;
      var banner = el("div", "bk-champ");
      banner.innerHTML = "🏆 <strong>" + c.flag + " " + esc(c.name) + "</strong> are your champions" +
        (ot ? " — drafted by <strong>" + esc(ot.name) + "</strong>" : "");
      host.appendChild(banner);
    }

    wrap.addEventListener("click", onBracketClick);
    wrap.addEventListener("change", onScoreChange);
  }

  function ownerBadge(abbr) {
    if (!abbr) return "";
    var t = TEAM_BY_ABBR[abbr];
    var color = t ? t.accent : "#888";
    return '<span class="bk-owner" style="--oc:' + color + '">' + esc(abbr) + "</span>";
  }

  function bracketMatchEl(mt, owners) {
    var node = el("div", "bk-match");
    node.setAttribute("data-match", mt.id);
    [["home", "ga", "homeGoals"], ["away", "gb", "awayGoals"]].forEach(function (side) {
      var slot = mt[side[0]];
      var cid = slot.countryId;
      var row = el("div", "bk-side");
      if (cid) row.setAttribute("data-pick", cid);
      if (mt.winnerId && mt.winnerId === cid) row.classList.add("win");
      if (mt.winnerId && cid && mt.winnerId !== cid) row.classList.add("lose");
      if (!cid) row.classList.add("tbd");
      var goalVal = mt[side[2]];
      row.innerHTML =
        '<span class="bk-flag">' + (slot.flag || "·") + "</span>" +
        '<span class="bk-name">' + (slot.name ? esc(slot.name) : "TBD") + "</span>" +
        (cid && owners[cid] ? ownerBadge(owners[cid]) : "") +
        '<input class="bk-score" type="number" min="0" inputmode="numeric" ' +
        'data-side="' + side[1] + '" value="' + (goalVal == null ? "" : goalVal) + '" ' +
        (cid ? "" : "disabled") + ' aria-label="goals" />';
      node.appendChild(row);
    });
    return node;
  }

  function onBracketClick(e) {
    if (e.target.classList.contains("bk-score")) return; // score taps aren't picks
    var side = e.target.closest(".bk-side[data-pick]");
    if (!side) return;
    var matchEl = side.closest(".bk-match");
    var matchId = matchEl.getAttribute("data-match");
    var countryId = side.getAttribute("data-pick");
    var prev = state.results[matchId] || {};
    /* Internally the winner is a countryId; tap the winner again to clear. */
    var winner = prev.winner === countryId ? null : countryId;
    var results = merge(state.results, {});
    results[matchId] = merge(prev, { winner: winner });
    commit(merge(state, { results: results }));
  }

  function onScoreChange(e) {
    if (!e.target.classList.contains("bk-score")) return;
    var matchId = e.target.closest(".bk-match").getAttribute("data-match");
    var sideKey = e.target.getAttribute("data-side"); // "ga" | "gb"
    var raw = e.target.value;
    var val = raw === "" ? null : Math.max(0, parseInt(raw, 10) || 0);
    var prev = state.results[matchId] || {};
    var patch = {}; patch[sideKey] = val;
    var results = merge(state.results, {});
    results[matchId] = merge(prev, patch);
    commit(merge(state, { results: results }));
  }

  /* ---------------- TAB: Standings (was Draft Board) ---------------- */

  function reachedBadge(reached) {
    if (reached === "Champion") return '<span class="st-tier champ">🏆 Champion</span>';
    if (reached === "—" || !reached) return '<span class="st-tier none">—</span>';
    return '<span class="st-tier">' + esc(reached) + "</span>";
  }

  function renderBoard(rows, started, animate) {
    var list = document.getElementById("board-list");
    if (!list) return;
    list.textContent = "";
    var hint = document.getElementById("board-hint");
    if (hint) {
      hint.textContent = started
        ? "Live knockout standings — re-ranks automatically as countries advance."
        : (draftComplete(state)
            ? "Draft locked. Everyone's on zero until the Round of 32 kicks off."
            : "Provisional draft order. Finish the snake draft to start scoring.");
    }

    rows.forEach(function (row, i) {
      var t = row.team;
      var li = el("li", "row" + (started && row.rank === 1 ? " is-first" : "") + (t.isMine ? " is-mine" : ""));
      li.dataset.abbr = t.abbr;
      if (animate) li.style.animationDelay = (i * 40) + "ms";
      else li.style.animation = "none";
      if (t.accent) li.style.setProperty("--row-accent", t.accent);

      var rankNum = row.rank || (i + 1);
      var rankInner = rankNum + "<small>" + ordinal(rankNum) + "</small>";
      var managers = (t.managers && t.managers.length) ? t.managers.join(" &amp; ")
        : (t.record ? "last season " + esc(t.record) : "");
      var crown = started && row.rank === 1 ? '<span class="st-crown">👑</span>' : "";
      var tie = row.tied && started ? '<span class="tie-flag">Tied</span>' : "";

      var flags = row.drafted.length
        ? row.drafted.map(function (c) {
            return '<span class="st-flag" title="' + esc(c.name) + '">' + c.flag + "</span>";
          }).join("")
        : '<span class="st-flag empty">—</span><span class="st-flag empty">—</span>';

      var pointsStr = started ? fmtPts(row.points) : "—";

      li.innerHTML =
        '<div class="rank' + (started ? "" : " prov") + '">' + crown + rankInner + "</div>" +
        crestHtml(t) +
        '<div class="team">' +
          '<div class="team-top">' +
            '<span class="team-name">' + esc(t.name) + "</span>" + tie +
          "</div>" +
          '<div class="team-managers">' + managers + "</div>" +
          '<div class="st-drafted">' +
            '<span class="st-flags">' + flags + "</span>" +
            reachedBadge(started ? row.reached : "—") +
          "</div>" +
        "</div>" +
        '<div class="stats">' +
          '<span class="goals">' + pointsStr + "</span>" +
          '<span class="goals-label">Points</span>' +
          (started
            ? '<div class="st-sub">' + row.advancePoints + " adv · " + row.goals + " ⚽ · " +
              row.aliveCount + " alive</div>"
            : '<div class="st-sub">awaiting draft</div>') +
        "</div>";
      list.appendChild(li);
    });
  }

  /* ---------------- live / next-up strip ---------------- */

  var countdownTimer = null;
  var RAIL_WINDOW_MS = 10 * 86400000;
  var RAIL_MAX = 40;

  function renderLive(fixtures) {
    var wrap = document.getElementById("livewrap");
    if (!wrap) return;
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

    /* Pre-draft: the strip is the gate's call-to-action, not a fixture rail. */
    if (!draftComplete(state)) {
      var seq = pickSequence(state);
      var left = seq.length - state.pickLog.length;
      wrap.innerHTML =
        '<div class="live-gate">' +
          '<span class="live-gate-ico">🐍</span>' +
          '<div class="live-gate-text"><strong>Draft in progress</strong>' +
          "<small>" + state.pickLog.length + " / " + seq.length + " picks · " +
          left + " to go — the hub unlocks at 24</small></div>" +
          '<button type="button" class="live-gate-btn" data-tab="snake">Open the draft →</button>' +
        "</div>";
      return;
    }

    var now = new Date();
    var owners = ownersByCountry(state);
    var todayK = dayKey(now);
    var tomorrowK = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

    var live = fixtures.filter(function (fx) { return Live.INPLAY[fx.status]; });
    var withTeams = fixtures.filter(function (fx) {
      return fx.home && fx.away && fx.home.name && fx.away.name;
    });

    var todayGames = withTeams
      .filter(function (fx) { return dayKey(fxDate(fx)) === todayK; })
      .sort(function (a, b) { return fxDate(a) - fxDate(b); });
    var tomorrowGames = withTeams
      .filter(function (fx) { return dayKey(fxDate(fx)) === tomorrowK; })
      .sort(function (a, b) { return fxDate(a) - fxDate(b); });

    var weekOut = new Date(now.getTime() + RAIL_WINDOW_MS);
    var laterAll = withTeams
      .filter(function (fx) {
        var k = dayKey(fxDate(fx));
        if (k === todayK || k === tomorrowK) return false;
        return !Live.FINISHED[fx.status] && !Live.INPLAY[fx.status] && fxDate(fx) > now;
      })
      .sort(function (a, b) { return fxDate(a) - fxDate(b); });
    var later = laterAll.filter(function (fx) { return fxDate(fx) <= weekOut; });
    if (!later.length) later = laterAll.slice(0, 8);
    later = later.slice(0, RAIL_MAX);

    if (!todayGames.length && !tomorrowGames.length && !later.length && !live.length) {
      var champ = champion(state);
      wrap.innerHTML = '<div class="live-head">' +
        (champ ? "🏆 We have a champion — the bracket is complete."
               : "Bracket awaiting results — tap winners on the Bracket tab.") +
        "</div>";
      return;
    }

    var anyLive = live.length > 0;
    var nextKick = null;
    if (!anyLive) {
      var pending = todayGames.concat(tomorrowGames, later).filter(function (fx) {
        return !Live.FINISHED[fx.status] && !Live.INPLAY[fx.status] && fxDate(fx) > now;
      });
      if (pending.length) nextKick = pending[0];
    }

    var sections = [];
    if (todayGames.length || tomorrowGames.length) {
      if (todayGames.length) sections.push({ key: "today", label: "Today", games: todayGames });
      if (tomorrowGames.length) sections.push({ key: "tomorrow", label: "Tomorrow", games: tomorrowGames });
      if (later.length) sections.push({ key: "later", label: "Next up", games: later });
    } else {
      sections.push({ key: "later", label: "Next up", games: later });
    }

    var rail = nextKick ? nextKickCard(nextKick, owners, now) : "";
    sections.forEach(function (sec) {
      var liveHere = anyLive && sec.key === "today";
      var meta = liveHere ? ' · <span class="rail-sec-cd">live</span>' : "";
      rail += '<div class="rail-sec"><span class="rail-sec-inner">' +
        (liveHere ? '<span class="live-dot sm"></span> ' : "") +
        sec.label + meta + "</span></div>";
      rail += sec.games.map(function (fx) {
        return matchMini(fx, owners, Live.INPLAY[fx.status], now);
      }).join("");
    });

    wrap.innerHTML = '<div class="live-cards">' + rail + "</div>";

    if (nextKick) {
      var target = fxDate(nextKick);
      var tick = function () {
        var diff = target - new Date();
        var node = document.getElementById("countdown");
        if (!node) return;
        if (diff <= 0) { node.textContent = "kicking off"; return; }
        var d = Math.floor(diff / 86400000), h = Math.floor(diff / 3600000) % 24,
            m = Math.floor(diff / 60000) % 60, s = Math.floor(diff / 1000) % 60;
        node.textContent = (d ? d + "d " : "") + (h || d ? h + "h " : "") + m + "m " + s + "s";
      };
      tick();
      countdownTimer = setInterval(tick, 1000);
    }
  }

  function scoreOrTime(fx) {
    if (fx.homeGoals != null && fx.awayGoals != null) return fx.homeGoals + "–" + fx.awayGoals;
    var t = fmtTime(fx);
    return t || "TBD";
  }

  function ownerTag(country, owners) {
    if (!country || !country.countryId) return "";
    var abbr = owners[country.countryId];
    if (!abbr) return "";
    var t = TEAM_BY_ABBR[abbr];
    return '<span class="mini-owner" style="--ac:' + (t && t.accent || "#c89638") + '">' + esc(abbr) + "</span>";
  }

  function matchMini(fx, owners, isLive, now) {
    var done = Live.FINISHED[fx.status];
    var isToday = now && dayKey(fxDate(fx)) === dayKey(now);
    var when = (isLive || done || isToday) ? "" : '<div class="mini-when">' + fmtDay(fxDate(fx)) + "</div>";
    return '<div class="mini mc-mini' + (isLive ? " live" : done ? " done" : "") + '"' +
      ' data-mc="' + esc(fx.id) + '" role="button" tabindex="0" aria-label="Open match center for ' +
      esc(fx.home.name) + " vs " + esc(fx.away.name) + '">' +
      '<div class="mini-grp">' + esc(fx.roundLabel || fx.round) + " " +
        ownerTag(fx.home, owners) + ownerTag(fx.away, owners) +
        (done ? '<span class="mini-ft">FT</span>' : "") + "</div>" +
      when +
      '<div class="mini-row"><span>' + fx.home.flag + " " + esc(fx.home.name) + "</span></div>" +
      '<div class="mini-score">' + scoreOrTime(fx) +
        (isLive ? ' <span class="mini-live">●</span>' +
          (fx.minute ? '<span class="mini-min">' + esc(fx.minute) + "</span>" : "") : "") + "</div>" +
      '<div class="mini-row"><span>' + fx.away.flag + " " + esc(fx.away.name) + "</span></div>" +
      "</div>";
  }

  function nextKickCard(fx, owners, now) {
    var sameDay = dayKey(fxDate(fx)) === dayKey(now);
    var when = (sameDay ? "Today" : fmtDay(fxDate(fx))) + (fmtTime(fx) ? " · " + fmtTime(fx) : "");
    return '<div class="mini mini-next">' +
      '<div class="mini-grp"><span class="next-kick-ico">⏱</span> Next kickoff ' +
        ownerTag(fx.home, owners) + ownerTag(fx.away, owners) + "</div>" +
      '<div class="next-kick-cd"><span id="countdown"></span></div>' +
      '<div class="next-kick-match">' +
        fx.home.flag + " " + esc(fx.home.name) + " v " + fx.away.flag + " " + esc(fx.away.name) + "</div>" +
      '<div class="next-kick-when">' + esc(when) + "</div>" +
      "</div>";
  }

  /* ---------------- schedule (grouped by round; kept for module reuse) ----------------
     There is no Schedule tab in the knockout shell, but the helper is kept
     callable so a future schedule panel (or a module) can render the flat
     fixtures grouped by round. No-ops gracefully if the host is absent. */
  function renderSchedule(fixtures) {
    var host = document.getElementById("schedule-list");
    if (!host) return;
    host.textContent = "";
    var owners = ownersByCountry(state);
    var now = new Date();

    var byRound = {};
    var order = [];
    fixtures.forEach(function (fx) {
      if (!byRound[fx.round]) { byRound[fx.round] = []; order.push(fx.round); }
      byRound[fx.round].push(fx);
    });
    if (!order.length) {
      host.appendChild(el("p", "empty-note", "No matches yet."));
      return;
    }
    order.forEach(function (rk) {
      host.appendChild(el("div", "day-head", esc(roundLabel(rk))));
      var grid = el("div", "sched-day");
      byRound[rk].forEach(function (fx) { grid.appendChild(scheduleCard(fx, owners, now)); });
      host.appendChild(grid);
    });
  }

  function scheduleCard(fx, owners, now) {
    var st = statusInfo(fx);
    var card = el("div", "match" + (st.live ? " is-live" : "") + (st.done ? " is-done" : ""));
    if (fx.id) card.id = "sched-" + fx.id;
    var hg = fx.homeGoals, ag = fx.awayGoals;
    var hasScore = hg != null && ag != null;
    var rows =
      '<div class="m-row"><span class="m-flag">' + (fx.home.flag || "·") + "</span>" +
        '<span class="m-name">' + esc(fx.home.name || "TBD") + "</span>" +
        (hasScore ? '<span class="m-pts">' + hg + "</span>" : "") + "</div>" +
      '<div class="m-row"><span class="m-flag">' + (fx.away.flag || "·") + "</span>" +
        '<span class="m-name">' + esc(fx.away.name || "TBD") + "</span>" +
        (hasScore ? '<span class="m-pts">' + ag + "</span>" : "") + "</div>";
    card.innerHTML =
      '<div class="m-meta"><span class="m-grp">' + esc(fx.roundLabel || fx.round) + "</span>" +
        '<span class="m-pill ' + st.key + '">' + st.label + "</span></div>" +
      '<div class="m-rows">' + rows + "</div>";
    return card;
  }

  /* ---------------- meta / rules ---------------- */

  function renderMeta(started, fixtures, bracket, liveData) {
    var meta = document.getElementById("hero-meta");
    if (meta) {
      if (!draftComplete(state)) {
        var seq = pickSequence(state);
        meta.innerHTML =
          '<span class="hero-pill"><b>12</b> teams</span>' +
          '<span class="hero-pill"><b>' + state.pickLog.length + "/" + seq.length + "</b> drafted</span>" +
          '<span class="hero-pill">🔒 hub locked</span>';
      } else {
        var done = fixtures.filter(function (fx) { return Live.FINISHED[fx.status]; }).length;
        var goals = 0;
        bracket.rounds.forEach(function (round) {
          round.matches.forEach(function (mt) {
            if (typeof mt.homeGoals === "number") goals += mt.homeGoals;
            if (typeof mt.awayGoals === "number") goals += mt.awayGoals;
          });
        });
        meta.innerHTML =
          '<span class="hero-pill"><b>24</b> drafted</span>' +
          '<span class="hero-pill"><b>' + goals + "</b> goals</span>" +
          '<span class="hero-pill"><b>' + done + "/" + fixtures.length + "</b> matches</span>" +
          '<span class="hero-pill">' + (started ? "🟢 Live" : "Awaiting kickoff") + "</span>";
      }
    }

    var dn = document.getElementById("draw-note");
    if (dn) dn.textContent = LEAGUE.drawNote;

    var le = document.getElementById("live-explain");
    if (le) {
      le.innerHTML =
        "<h3>Live updates</h3>" +
        "<p>Bracket results are entered by hand for v1 — tap the winners and type the goals on the " +
        "Bracket tab. A live feed will overlay goals automatically once the knockout begins.</p>" +
        "<p class=\"muted\">Disputes about goals or advancement? The official FIFA match report wins, then the commissioner.</p>";
    }
  }

  /* ---------------- draft gate (locks tabs) ---------------- */

  /* Dim a locked tab button + mark it with a lock affordance. */
  function setTabLocked(name, locked) {
    document.querySelectorAll('.tab[data-tab="' + name + '"]').forEach(function (b) {
      b.classList.toggle("is-locked", locked);
      b.setAttribute("aria-disabled", locked ? "true" : "false");
    });
  }

  /* Apply lock state to every tab + drop a gate banner into the open,
     locked panel (if any). */
  function applyGate() {
    var locked = !draftComplete(state);

    /* Once the draft is locked in, the two setup tabs are removed from the
       nav and replaced by the Draft Recap. Applies to both the top and the
       bottom nav (querySelectorAll catches every copy of each button). */
    document.querySelectorAll('.tab[data-tab="draft-order"], .tab[data-tab="snake"]')
      .forEach(function (b) { b.hidden = !locked; });
    document.querySelectorAll('.tab[data-tab="recap"]')
      .forEach(function (b) { b.hidden = locked; });

    tabNames().forEach(function (name) {
      setTabLocked(name, locked && isLockedTab(name));
    });
    document.querySelectorAll(".gate-banner").forEach(function (n) { n.remove(); });
    if (locked && isLockedTab(activeTab)) {
      var panel = document.getElementById("tab-" + activeTab);
      if (panel) {
        var seq = pickSequence(state);
        var left = seq.length - state.pickLog.length;
        var banner = el("div", "gate-banner",
          '<div class="gate-lock">🔒</div>' +
          '<h3 class="gate-title">Finish the draft first</h3>' +
          '<p class="gate-sub">The bracket, standings and forecast unlock once all ' +
          seq.length + " picks are in — <strong>" + left + " to go</strong>.</p>" +
          '<button type="button" class="gate-btn" data-tab="snake">🐍 Go to the snake draft</button>');
        panel.insertBefore(banner, panel.firstChild);
      }
    }
  }

  /* ---------------- tabs ---------------- */

  function tabNames() {
    return Array.prototype.map.call(
      document.querySelectorAll("#tabs .tab"),
      function (b) { return b.dataset.tab; }
    );
  }

  function setTab(name, opts) {
    /* Post-draft the setup tabs are retired — route them to the recap. */
    if (draftComplete(state) && (name === "draft-order" || name === "snake")) {
      name = "recap";
    }
    if (isLockedTab(name)) {
      name = "snake";
      activeTab = "snake";
      toast("Finish the draft to unlock that");
    } else {
      activeTab = name;
    }
    document.querySelectorAll(".tab[data-tab]").forEach(function (b) {
      var on = b.dataset.tab === name;
      b.classList.toggle("is-active", on);
      if (on && b.closest("#tabs") && b.scrollIntoView) {
        b.scrollIntoView({ inline: "center", block: "nearest" });
      }
    });
    tabNames().forEach(function (n) {
      var panel = document.getElementById("tab-" + n);
      if (!panel) return;
      var on = n === name;
      panel.hidden = !on;
      panel.classList.toggle("is-active", on);
    });
    if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    applyGate();
    if (!(opts && opts.noScroll)) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function wireTabs() {
    document.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-tab]");
      if (!btn) return;
      var name = btn.getAttribute("data-tab");
      if (tabNames().indexOf(name) < 0) return;
      e.preventDefault();
      setTab(name);
    });
    var hash = (location.hash || "").replace("#", "");
    if (tabNames().indexOf(hash) >= 0 && !isLockedTab(hash)) activeTab = hash;
  }

  /* ---------------- Hub (feature-module API) ---------------- */

  var lastCtx = null;
  var firstRender = true;
  var renderCallbacks = [];

  function buildCtx(fixtures, bracketRounds, rows, started, liveData) {
    var owners = ownersByCountry(state);
    var fieldList = FIELD.map(function (c) {
      var ownedBy = owners[c.id] || null;
      return Object.assign({}, c, { drafted: !!ownedBy, draftedBy: ownedBy });
    });
    var byId = {};
    fieldList.forEach(function (c) { byId[c.id] = c; });

    return {
      league: LEAGUE,
      teams: TEAMS,
      field: { byId: byId, list: fieldList },
      bracket: { rounds: bracketRounds },
      fixtures: fixtures,
      allFixtures: fixtures,
      draft: {
        order: state.draftOrder.slice(),
        picks: state.pickLog.slice(),
        complete: draftComplete(state),
        ownersByCountry: owners,
        countriesByTeam: countriesByTeam(state)
      },
      standings: rows,
      started: started,
      liveData: liveData || null,
      helpers: {
        esc: esc, el: el, ordinal: ordinal, crestHtml: crestHtml,
        fxDate: fxDate, dayKey: dayKey, fmtDay: fmtDay, fmtTime: fmtTime,
        statusInfo: statusInfo, buildStandings: buildStandings,
        ownerByCountry: ownerByCountry, countryTeamOwner: countryTeamOwner,
        countryById: countryById, advancePoints: advancePoints,
        teamKnockoutPoints: teamKnockoutPoints, roundLabel: roundLabel
      }
    };
  }

  function renderAll(liveData) {
    /* Live mutations are no-ops pre-draft (Live guards internally). */
    var matches = (liveData && liveData.matches) || [];
    Live.applyMatches(matches);
    Live.applyCards(liveData && liveData.cards && liveData.cards.byCountry);
    Live.applyFouls(liveData && liveData.fouls && liveData.fouls.byCountry);

    var bracketRounds = buildBracket(state);
    var fixtures = buildKnockoutFixtures(bracketRounds, { byId: COUNTRY_BY_ID, list: FIELD });
    Live.attachToFixtures(fixtures, matches, liveData && liveData.cards && liveData.cards.byMatch);

    var started = seasonStarted(bracketRounds);
    var rows = standings(state);

    /* Core renders. */
    renderDraftOrder();
    renderSnakeDraft();
    renderRecap();
    renderBracket();
    renderBoard(rows, started, firstRender);
    renderLive(fixtures);
    renderSchedule(fixtures);
    renderMeta(started, fixtures, { rounds: bracketRounds }, liveData);
    firstRender = false;

    lastCtx = buildCtx(fixtures, bracketRounds, rows, started, liveData);

    /* Re-apply the gate after panels re-render (banner lives in a panel). */
    applyGate();

    renderCallbacks.forEach(function (fn) {
      try { fn(lastCtx); } catch (err) { console.error("Hub module render failed:", err); }
    });
    return lastCtx;
  }

  window.Hub = {
    ctx: function () { return lastCtx; },
    onRender: function (fn) {
      renderCallbacks.push(fn);
      if (lastCtx) {
        try { fn(lastCtx); } catch (err) { console.error("Hub module render failed:", err); }
      }
    },
    refresh: function () {
      return Live.load().then(renderAll).catch(function () { return renderAll(null); });
    },
    setTab: setTab
  };

  /* ---------------- boot ---------------- */

  function boot() {
    try {
      wireTabs();
      /* Initial render is offline-safe — never blocks on Live.load(). */
      renderAll(null);
      setTab(activeTab, { noScroll: true });
      /* Best-effort live overlay; failure leaves the offline render in place. */
      Live.load().then(function (data) { if (data) renderAll(data); }).catch(function () {});
    } catch (err) {
      var list = document.getElementById("board-list");
      if (list) {
        list.innerHTML =
          '<li class="row"><div></div><div></div><div class="team">' +
          '<div class="team-name">Data error</div><div class="team-managers">' +
          esc(err && err.message || String(err)) + "</div></div><div></div></li>";
      }
      if (window.console) console.error(err);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
