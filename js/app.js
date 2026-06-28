/* ============================================================
   ORCHESTRATOR — WC26 Knockout Pool ("The Longest Yard").

   Owns the draft GATE, the core tabs (Draft Order, Snake Draft,
   Bracket, Standings), the live strip, the hero meta, and the
   window.Hub contract that every feature module reads.

   State is the single source of truth in store.js (localStorage
   "wc26ko.v4"). This file renders it, writes back through small
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
    /* The draft is FINAL: once complete, refuse any change to the draft itself
       (picks / order / direction). The shallow merge keeps refs for untouched
       fields, so bracket result writes (which only change `results`) still pass
       through. This keeps the published draft immutable for every member and
       stops a stray click from clearing it locally — which a newer local
       updatedAt would otherwise make permanent (applyShared only overwrites a
       strictly-newer feed, and Hub.refresh never re-applies it). */
    if (wasComplete && next &&
        (next.pickLog !== state.pickLog ||
         next.draftOrder !== state.draftOrder ||
         (next.config !== state.config &&
          (!next.config || !state.config ||
           next.config.draftDirection !== state.config.draftDirection)))) {
      toast("🔒 The draft is final");
      return;
    }
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
      hint.textContent = "One person runs the draft for the whole league — seed the snake here. " +
        "Top of the list picks first. Reorder with the arrows, or flip the whole order.";
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
      /* Q6: once picks exist, reordering silently reassigns drafted countries —
         gate it behind a confirm (mirrors the Reset-draft confirm). */
      if (state.pickLog.length > 0 &&
          !confirm("Draft has started — reordering reshuffles who picked what. Reorder anyway?")) return;
      var nextOrder = state.draftOrder.slice();
      var tmp = nextOrder[i]; nextOrder[i] = nextOrder[j]; nextOrder[j] = tmp;
      commit(merge(state, { draftOrder: nextOrder }));
    });

    var actions = el("div", "do-actions");
    var flip = el("button", "do-btn", "⇅ Flip best-first / worst-first");
    flip.addEventListener("click", function () {
      /* Q6: same guard for the whole-order flip. */
      if (state.pickLog.length > 0 &&
          !confirm("Draft has started — flipping reshuffles who picked what. Flip anyway?")) return;
      /* Track the direction so the Recap label reflects the real seed order. */
      var nextDir = (state.config && state.config.draftDirection === "worst-first")
        ? "best-first" : "worst-first";
      commit(merge(state, {
        draftOrder: state.draftOrder.slice().reverse(),
        config: merge(state.config, { draftDirection: nextDir })
      }));
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
      hint.textContent = "One person (the commissioner) drafts for the whole league — if that's not you, " +
        "you're just watching. 2 countries each · snake order gives everyone one earlier (stronger) and one " +
        "later (weaker) pick. The hub unlocks once all " + seq.length + " are in. " +
        state.pickLog.length + " / " + seq.length + " picks made.";
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
    actions.appendChild(copyBtn);
    /* No "Re-open draft" control: the draft is final and the Recap is read-only.
       (Re-opening would clear picks + re-lock the hub for that member, and a
       newer local timestamp would make it permanent — see the commit() guard.) */
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

  /* BB1: copy the exportable shared-bracket JSON to the clipboard, with a
     legacy fallback for browsers without navigator.clipboard. */
  function copyExport() {
    var text = exportState();
    var ok = function () { toast("Copied — commit to data/results.json"); };
    var fail = function () { toast("Copy failed"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, fail);
      return;
    }
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var done = document.execCommand("copy");
      document.body.removeChild(ta);
      done ? ok() : fail();
    } catch (e) { fail(); }
  }

  /* ---------------- TAB: Bracket ---------------- */

  function renderBracket() {
    var host = document.getElementById("bracket-host");
    if (!host) return;
    host.textContent = "";

    /* BB8: while this tab is locked, leave the body empty so the gate banner
       (injected by applyGate into the active locked panel) is the sole focus —
       no half-rendered bracket behind it. */
    if (isLockedTab("bracket")) return;

    /* BB1: understated commissioner action — copy the shared bracket JSON to the
       clipboard so it can be committed to data/results.json. */
    var tools = el("div", "bk-tools");
    var exportBtn = el("button", "sd-btn-ghost", "⬇ Export for the league");
    exportBtn.setAttribute("type", "button");
    exportBtn.addEventListener("click", copyExport);
    tools.appendChild(exportBtn);
    host.appendChild(tools);

    var owners = ownersByCountry(state);
    var rounds = buildBracket(state); // [R32, R16, QF, SF, Final]
    var wrap = el("div", "bk2");

    function colEl(round, matches, posClass) {
      var col = el("div", "bk-col " + posClass);
      col.appendChild(el("div", "bk-round", esc(round.label)));
      var mw = el("div", "bk-matches");
      matches.forEach(function (mt) { mw.appendChild(bracketMatchEl(mt, owners)); });
      col.appendChild(mw);
      return col;
    }
    function halfOf(arr, side) {
      var n = arr.length / 2;
      return side === "L" ? arr.slice(0, n) : arr.slice(n);
    }

    // Two-sided bracket: left half (R32→SF) and right half (R32→SF) converge
    // on the centered Final. The first half of each round's matches feeds the
    // left semifinal; the second half feeds the right semifinal (buildBracket
    // merges adjacent matches, so this split matches the real tree).
    var sideRounds = [rounds[0], rounds[1], rounds[2], rounds[3]]; // R32, R16, QF, SF

    var left = el("div", "bk2-side bk2-left");
    sideRounds.forEach(function (r) {
      left.appendChild(colEl(r, halfOf(r.matches, "L"), "bk-col-L"));
    });
    wrap.appendChild(left);

    var center = el("div", "bk2-center");
    center.appendChild(colEl(rounds[4], rounds[4].matches, "bk-col-final"));
    wrap.appendChild(center);

    var right = el("div", "bk2-side bk2-right");
    sideRounds.slice().reverse().forEach(function (r) { // SF, QF, R16, R32 outward
      right.appendChild(colEl(r, halfOf(r.matches, "R"), "bk-col-R"));
    });
    wrap.appendChild(right);

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
    wrap.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      var side = e.target.closest(".bk-side[data-pick]");
      if (!side) return;
      e.preventDefault();
      onBracketClick(e);
    });

    /* Draw the connectors whenever the bracket actually has a size — this fires
       on first paint, when the tab is shown (display:none → visible), and on any
       resize. A ResizeObserver is reliable where a one-shot rAF races the tab
       becoming visible (which collapses every measurement to 0). */
    _bkWrap = wrap;
    if (_bkRO) _bkRO.disconnect();
    if (typeof ResizeObserver === "function") {
      _bkRO = new ResizeObserver(function () {
        if (_bkRAF) cancelAnimationFrame(_bkRAF);
        _bkRAF = requestAnimationFrame(function () { drawBracketLines(wrap); });
      });
      _bkRO.observe(wrap);
    } else {
      requestAnimationFrame(function () { drawBracketLines(wrap); });
    }
  }

  /* SVG elbow connectors over the two-sided bracket. Reads laid-out card
     positions so it stays exact regardless of card height / spacing. */
  var _bkWrap = null;
  var _bkRO = null;
  var _bkRAF = null;
  function drawBracketLines(wrap) {
    if (!wrap || !wrap.isConnected) return;
    var NS = "http://www.w3.org/2000/svg";
    var old = wrap.querySelector("svg.bk2-lines");
    if (old) old.remove();
    var W = wrap.scrollWidth, H = wrap.scrollHeight;
    if (!W || !H || !wrap.querySelector(".bk-match")) return; // hidden / not laid out yet
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "bk2-lines");
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    var base = wrap.getBoundingClientRect();
    function R(matchEl) {
      var r = matchEl.getBoundingClientRect();
      return {
        left: r.left - base.left + wrap.scrollLeft,
        right: r.right - base.left + wrap.scrollLeft,
        midY: (r.top + r.bottom) / 2 - base.top + wrap.scrollTop
      };
    }
    function elbow(x1, y1, x2, y2) {
      var mx = (x1 + x2) / 2;
      var p = document.createElementNS(NS, "path");
      p.setAttribute("d", "M" + x1 + " " + y1 + " H" + mx + " V" + y2 + " H" + x2);
      p.setAttribute("class", "bk2-line");
      svg.appendChild(p);
    }
    function joinCols(cols, fromInnerToOuter) {
      // adjacent columns: each match feeds the match at floor(index/2) in the
      // column nearer the centre. fromInnerToOuter=false → left side (cols run
      // outer→inner, lines exit right edge); true → right side (exit left edge).
      for (var i = 0; i < cols.length - 1; i++) {
        var a = cols[i].querySelectorAll(".bk-match");          // more matches
        var b = cols[i + 1].querySelectorAll(".bk-match");      // half as many
        for (var m = 0; m < a.length; m++) {
          var s = R(a[m]), d = R(b[Math.floor(m / 2)]);
          if (!fromInnerToOuter) elbow(s.right, s.midY, d.left, d.midY);
          else elbow(s.left, s.midY, d.right, d.midY);
        }
      }
    }
    var leftCols = wrap.querySelectorAll(".bk2-left .bk-col");   // [R32,R16,QF,SF]
    var rightCols = wrap.querySelectorAll(".bk2-right .bk-col"); // [SF,QF,R16,R32]
    joinCols(Array.prototype.slice.call(leftCols), false);
    // right side: iterate outer→inner, so reverse the node list
    joinCols(Array.prototype.slice.call(rightCols).reverse(), true);
    // semifinals → final
    var fin = wrap.querySelector(".bk-col-final .bk-match");
    if (fin) {
      var f = R(fin);
      var lsf = leftCols.length ? leftCols[leftCols.length - 1].querySelector(".bk-match") : null;
      var rsf = rightCols.length ? rightCols[0].querySelector(".bk-match") : null;
      if (lsf) { var ls = R(lsf); elbow(ls.right, ls.midY, f.left, f.midY); }
      if (rsf) { var rs = R(rsf); elbow(rs.left, rs.midY, f.right, f.midY); }
    }
    wrap.insertBefore(svg, wrap.firstChild);
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

    /* BB5: both goals entered and EQUAL → the winner is a shootout result.
       Scoring is unchanged (winner advances, both goals still count); we only
       add the visual "decide on penalties" hint + a "(pens)" tag on the winner. */
    var tied = typeof mt.homeGoals === "number" &&
      typeof mt.awayGoals === "number" && mt.homeGoals === mt.awayGoals;
    if (tied) node.classList.add("is-pk");

    [["home", "ga", "homeGoals"], ["away", "gb", "awayGoals"]].forEach(function (side) {
      var slot = mt[side[0]];
      var cid = slot.countryId;
      var row = el("div", "bk-side");
      var isWinner = mt.winnerId && mt.winnerId === cid;
      var wonOnPens = tied && isWinner;
      if (cid) {
        row.setAttribute("data-pick", cid);
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");
        row.setAttribute("aria-pressed", isWinner ? "true" : "false");
        var team = TEAM_BY_ABBR[owners[cid]];
        var act = tied ? " — decide on penalties (set shootout winner)" : " — set winner";
        row.setAttribute("aria-label",
          (slot.name || "") + act + (wonOnPens ? " (won on penalties)" : "") +
          (team ? " (drafted by " + team.name + ")" : ""));
      }
      if (isWinner) row.classList.add("win");
      if (mt.winnerId && cid && mt.winnerId !== cid) row.classList.add("lose");
      if (!cid) row.classList.add("tbd");
      var goalVal = mt[side[2]];
      var goalLabel = slot.name ? slot.name + " goals" : "goals";
      row.innerHTML =
        '<span class="bk-flag">' + (slot.flag || "·") + "</span>" +
        '<span class="bk-name">' + (slot.name ? esc(slot.name) : "TBD") +
          (wonOnPens ? ' <span class="bk-pens">(pens)</span>' : "") + "</span>" +
        (cid && owners[cid] ? ownerBadge(owners[cid]) : "") +
        '<input class="bk-score" type="number" min="0" inputmode="numeric" ' +
        'data-side="' + side[1] + '" value="' + (goalVal == null ? "" : goalVal) + '" ' +
        (cid ? "" : "disabled") + ' aria-label="' + esc(goalLabel) + '" />';
      node.appendChild(row);
    });

    /* BB5: PK hint sits under the two sides whenever the score is level — it
       tells the commissioner the winner tap is a shootout call. Once a winner
       is set, surface it as "decided on penalties". */
    if (tied) {
      var pkLabel = mt.winnerId ? "PK · decided on penalties" : "PK · decide on penalties";
      node.appendChild(el("div", "bk-pk-hint", '<span class="bk-pk-tag">PK</span>' + esc(pkLabel.slice(5))));
    }
    return node;
  }

  /* The home/away countryIds for a match, read live from the rendered DOM
     (the bk-side rows carry data-pick). Returns { aId, bId } with nulls for
     any TBD slot. Used to stamp results with the slots they were entered for
     (B1 shared contract) and to reconcile winner vs. goals (B5). */
  function matchSlotIds(matchEl) {
    var sides = matchEl.querySelectorAll(".bk-side");
    var aId = sides[0] ? (sides[0].getAttribute("data-pick") || null) : null;
    var bId = sides[1] ? (sides[1].getAttribute("data-pick") || null) : null;
    return { aId: aId, bId: bId };
  }

  function onBracketClick(e) {
    if (e.target.classList.contains("bk-score")) return; // score taps aren't picks
    var side = e.target.closest(".bk-side[data-pick]");
    if (!side) return;
    var matchEl = side.closest(".bk-match");
    var matchId = matchEl.getAttribute("data-match");
    var countryId = side.getAttribute("data-pick");
    var slots = matchSlotIds(matchEl);
    var prev = state.results[matchId] || {};
    /* Internally the winner is a countryId; tap the winner again to clear. */
    var winner = prev.winner === countryId ? null : countryId;
    var results = merge(state.results, {});
    /* B1: stamp the slots this result was entered for.
       BB2: mark this as a manual entry so the live auto-feed never overrides it. */
    results[matchId] = merge(prev, { winner: winner, aId: slots.aId, bId: slots.bId, manual: true });
    commit(merge(state, { results: results }));
  }

  /* B6: parse a goal input. Returns:
       undefined  -> reject the edit (keep prior stored value)
       null       -> the field was cleared (distinct from a real 0)
       0..20      -> a valid, clamped integer
     Non-finite, non-integer ("abc", "3.5") inputs are rejected. */
  function parseGoals(raw) {
    var s = String(raw).trim();
    if (s === "") return null;            // cleared, not a 0
    if (!/^[0-9]+$/.test(s)) return undefined; // non-integer / garbage -> reject
    var n = Number(s);
    if (!isFinite(n)) return undefined;
    return Math.max(0, Math.min(20, n));  // clamp 0..20
  }

  function onScoreChange(e) {
    if (!e.target.classList.contains("bk-score")) return;
    var matchEl = e.target.closest(".bk-match");
    var matchId = matchEl.getAttribute("data-match");
    var sideKey = e.target.getAttribute("data-side"); // "ga" | "gb"
    var raw = e.target.value;
    var prev = state.results[matchId] || {};
    var val = parseGoals(raw);
    if (val === undefined) {
      /* B6: reject — restore the prior stored value in the input and bail. */
      var prior = prev[sideKey];
      e.target.value = (prior == null ? "" : prior);
      return;
    }
    var slots = matchSlotIds(matchEl);
    var patch = {};
    patch[sideKey] = val;
    /* B1: stamp the slots this result was entered for. */
    patch.aId = slots.aId;
    patch.bId = slots.bId;
    /* BB2: hand-entered goals are a manual result — protect it from the auto-feed. */
    patch.manual = true;

    /* B5: reconcile winner with goals. When both goals are entered and differ,
       the winner MUST be the higher-scoring side (auto-correct on edit). An
       equal score is left to an explicit winner tap (shootout pick). */
    var ga = sideKey === "ga" ? val : prev.ga;
    var gb = sideKey === "gb" ? val : prev.gb;
    if (typeof ga === "number" && typeof gb === "number" && ga !== gb) {
      patch.winner = ga > gb ? slots.aId : slots.bId;
    } else if (val === null && prev.winner &&
               prev.winner === (sideKey === "ga" ? slots.aId : slots.bId)) {
      /* Cleared the winning side's goal box — drop the now-inconsistent winner
         (no blank-goal "winner" left standing). Re-tap or re-enter to set it. */
      patch.winner = null;
    }

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
    /* BB8: while Standings is locked, suppress the body + hint so the gate banner
       is the focus rather than a provisional table sitting behind it. */
    if (isLockedTab("board")) {
      if (hint) hint.textContent = "";
      return;
    }
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
          left + " to go — the hub unlocks once all " + seq.length + " picks are in</small></div>" +
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

  /* ---------------- schedule (Schedule tab — day-grouped, like the live hub) ----------------
     Renders the flat knockout fixtures grouped by calendar day (a day header,
     then that day's matches), with kickoff-time pills, owner chips, calendar
     links and a Match Center button — mirroring wc26-draft-tracker's schedule.
     Real R32 per-match dates/times come from js/schedule.js; later rounds carry
     their round's representative date with TBD teams until results fill them in.
     No-ops gracefully if the host is absent. */
  var scheduleFilter = "next";
  var lastScheduleFixtures = [];

  /* Country ids drafted by the viewer's own team (null if no team is claimed). */
  function myCountryIds() {
    var mine = null;
    for (var i = 0; i < TEAMS.length; i++) { if (TEAMS[i].isMine) { mine = TEAMS[i]; break; } }
    if (!mine) return null;
    var owners = ownersByCountry(state);
    var set = {};
    Object.keys(owners).forEach(function (cid) { if (owners[cid] === mine.abbr) set[cid] = true; });
    return set;
  }

  function passesScheduleFilter(fx, now, mineSet) {
    var bothKnown = !!(fx.home && fx.away && fx.home.name && fx.away.name);
    switch (scheduleFilter) {
      case "r32": return fx.round === "R32";
      case "results": return !!Live.FINISHED[fx.status];
      case "mine":
        if (!mineSet) return false;
        return (fx.home.countryId && mineSet[fx.home.countryId]) ||
               (fx.away.countryId && mineSet[fx.away.countryId]);
      case "all": return true;
      case "next":
      default:
        if (Live.INPLAY[fx.status]) return true;
        if (Live.FINISHED[fx.status]) return false;
        return bothKnown; // upcoming, teams decided — hides TBD later rounds from the default view
    }
  }

  function renderSchedule(fixtures) {
    var host = document.getElementById("schedule-list");
    if (!host) return;
    if (fixtures && fixtures.length) lastScheduleFixtures = fixtures;
    wireScheduleFilters();
    host.textContent = "";
    var owners = ownersByCountry(state);
    var now = new Date();
    var mineSet = scheduleFilter === "mine" ? myCountryIds() : null;

    if (scheduleFilter === "mine" && !mineSet) {
      host.appendChild(el("p", "empty-note",
        "Claim your team (🏷 in the hero, or a ?team= link) to filter the schedule to your two countries."));
      return;
    }

    var shown = fixtures.filter(function (fx) { return passesScheduleFilter(fx, now, mineSet); })
      .sort(function (a, b) { return fxDate(a) - fxDate(b) || String(a.id).localeCompare(String(b.id)); });

    if (!shown.length) {
      host.appendChild(el("p", "empty-note", "No matches for this filter yet."));
      return;
    }

    // Group by calendar day: a full-width header, then that day's matches in a
    // grid. Each day keeps its own grid so an odd count never bleeds a hole.
    var lastDay = null, dayGrid = null;
    shown.forEach(function (fx) {
      var d = fxDate(fx);
      var key = dayKey(d);
      if (key !== lastDay) {
        lastDay = key;
        var isToday = key === dayKey(now);
        host.appendChild(el("div", "day-head" + (isToday ? " today" : ""),
          fmtDay(d) + (isToday ? ' <span class="today-pill">Today</span>' : "")));
        dayGrid = el("div", "sched-day");
        host.appendChild(dayGrid);
      }
      dayGrid.appendChild(scheduleCard(fx, owners, now));
    });
  }

  /* One delegated click listener on the filter chips (bound once). */
  function wireScheduleFilters() {
    var bar = document.getElementById("schedule-filters");
    if (!bar || bar.dataset.wired) return;
    bar.dataset.wired = "1";
    bar.addEventListener("click", function (e) {
      var chip = e.target.closest(".chip[data-filter]");
      if (!chip) return;
      scheduleFilter = chip.dataset.filter;
      bar.querySelectorAll(".chip[data-filter]").forEach(function (c) {
        c.classList.toggle("is-active", c === chip);
        c.setAttribute("aria-pressed", c === chip ? "true" : "false");
      });
      renderSchedule(lastScheduleFixtures);
    });
  }

  function scheduleTeamRow(side, goals, hasScore, win, lose, owners) {
    return '<div class="m-row' + (win ? " win" : "") + (lose ? " lose" : "") + '">' +
      '<span class="m-flag">' + (side.flag || "·") + "</span>" +
      '<span class="m-name">' + esc(side.name || "TBD") + "</span>" +
      ownerTag(side, owners) +
      (hasScore ? '<span class="m-pts">' + goals + "</span>" : "") +
      "</div>";
  }

  function scheduleCard(fx, owners, now) {
    var st = statusInfo(fx);
    var bothKnown = !!(fx.home.name && fx.away.name);
    var card = el("div", "match" + (st.live ? " is-live" : "") + (st.done ? " is-done" : "") +
      (bothKnown ? "" : " is-tbd"));
    if (fx.id) card.id = "sched-" + fx.id;

    var hg = fx.homeGoals, ag = fx.awayGoals;
    var hasScore = hg != null && ag != null;
    var homeWin = !!(st.done && hasScore && hg > ag);
    var awayWin = !!(st.done && hasScore && ag > hg);

    // Upcoming games show kickoff time in the pill (the date sits in the day header).
    var pillLabel = st.upcoming ? (fmtTime(fx) || "Upcoming") : st.label;
    var pill = '<span class="m-pill ' + st.key + (st.upcoming ? " time" : "") + '">' +
      (st.live ? '<span class="live-dot sm"></span>' : "") + pillLabel + "</span>";

    var rows =
      scheduleTeamRow(fx.home, hg, hasScore, homeWin, awayWin, owners) +
      scheduleTeamRow(fx.away, ag, hasScore, awayWin, homeWin, owners);

    var venue = fx.venue ? '<span class="m-venue">📍 ' + esc(fx.venue) + "</span>" : "";

    var actions = "";
    if (!st.done && !st.live && bothKnown) {
      var cal = Live.calendarUrl(fx.home.name, fx.away.name, fx.roundLabel || fx.round, fx.utcDate);
      if (cal) actions += '<a class="m-act ghost" target="_blank" rel="noopener" href="' + cal + '">＋ Calendar</a>';
    }
    if (bothKnown) {
      actions += '<button type="button" class="m-act mc-act" data-mc="' + esc(fx.id) +
        '" aria-haspopup="dialog">📊 Match Center</button>';
    }

    var foot = (venue || actions)
      ? '<div class="m-foot">' + venue + '<span class="m-actions">' + actions + "</span></div>"
      : "";

    card.innerHTML =
      '<div class="m-meta"><span class="m-grp">' + esc(fx.roundLabel || roundLabel(fx.round)) + "</span>" +
        pill + "</div>" +
      '<div class="m-rows">' + rows + "</div>" + foot;
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
          '<p class="gate-sub">One person drafts for the whole league. The bracket, standings and ' +
          "forecast unlock once all " + seq.length + " picks are in — <strong>" + left +
          " to go</strong>. (Once it's done, friends pick their team to highlight their picks.)</p>" +
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
    /* BB8: a locked tab is allowed to become active. Its renderer shows only the
       in-context gate banner (the panel body is suppressed while locked), so the
       gate is the focus instead of force-jumping to snake and toasting on every tap. */
    activeTab = name;
    document.querySelectorAll(".tab[data-tab]").forEach(function (b) {
      var on = b.dataset.tab === name;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      /* Roving tabindex within the top tablist so arrow keys, not Tab, walk it. */
      if (b.closest("#tabs")) b.tabIndex = on ? 0 : -1;
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

    /* WCAG tablist keyboard support: arrow keys (and Home/End) walk the top
       tabs, activating as focus moves. Hidden setup/recap tabs are skipped. */
    var tabsEl = document.getElementById("tabs");
    if (tabsEl) {
      tabsEl.addEventListener("keydown", function (e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" &&
            e.key !== "Home" && e.key !== "End") return;
        var btns = Array.prototype.slice
          .call(tabsEl.querySelectorAll(".tab[data-tab]"))
          .filter(function (b) {
            return !b.hidden && tabNames().indexOf(b.dataset.tab) >= 0;
          });
        if (!btns.length) return;
        var cur = btns.indexOf(document.activeElement);
        if (cur < 0) {
          for (var i = 0; i < btns.length; i++) {
            if (btns[i].classList.contains("is-active")) { cur = i; break; }
          }
        }
        if (cur < 0) cur = 0;
        var ni;
        if (e.key === "Home") ni = 0;
        else if (e.key === "End") ni = btns.length - 1;
        else if (e.key === "ArrowRight") ni = (cur + 1) % btns.length;
        else ni = (cur - 1 + btns.length) % btns.length;
        e.preventDefault();
        setTab(btns[ni].dataset.tab);
        btns[ni].focus();
      });
    }
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

  /* Mirror live IN-PLAY state (status / minute / partial score) from the live-
     attached fixtures onto the bracket the forecast reads. attachToFixtures only
     writes the live feed onto `fixtures`, but the odds / road / simulator modules
     read it from ctx.bracket.rounds — so without this an in-progress match never
     reaches the forecast and the odds sit frozen until the match goes final.
     Fixtures are built 1:1 from the bracket and share match ids, so we key on id.
     Only in-progress matches are copied: finished results already reach the
     bracket via the auto-advance path (winnerId), and a resolved match (winnerId
     set) is left untouched so a manual / auto result is never overwritten. */
  function overlayLiveOntoBracket(bracketRounds, fixtures) {
    var fxById = {};
    fixtures.forEach(function (fx) { fxById[fx.id] = fx; });
    bracketRounds.forEach(function (round) {
      round.matches.forEach(function (mt) {
        if (mt.winnerId) return;                     // resolved — leave it
        var fx = fxById[mt.id];
        if (!fx || !Live.INPLAY[fx.status]) return;  // only live, in-progress
        mt.status = fx.status;
        mt.minute = fx.minute || null;
        if (typeof fx.homeGoals === "number") mt.homeGoals = fx.homeGoals;
        if (typeof fx.awayGoals === "number") mt.awayGoals = fx.awayGoals;
      });
    });
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

    /* BB2: auto-advance the bracket from the live feed. Guarded so an empty feed
       (the common case in v1) is a complete no-op and never touches manual entry.
       Live.deriveResults finds FINISHED fixtures with a clear winner; applyAutoResults
       FILLS only empty matches (never overrides manual/shared/auto) and persists.
       If it changed the store, reload state and re-derive the bracket so the
       auto-advanced slots feed standings/ctx below. */
    if (matches.length &&
        Live && typeof Live.deriveResults === "function" &&
        typeof applyAutoResults === "function") {
      var derived = Live.deriveResults(fixtures);
      if (applyAutoResults(derived)) {
        state = loadState();
        bracketRounds = buildBracket(state);
        fixtures = buildKnockoutFixtures(bracketRounds, { byId: COUNTRY_BY_ID, list: FIELD });
        Live.attachToFixtures(fixtures, matches, liveData && liveData.cards && liveData.cards.byMatch);
      }
    }

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

    /* Let the forecast see live, in-progress matches (core renders above already
       read the live feed straight off `fixtures`, so they run un-overlaid). */
    overlayLiveOntoBracket(bracketRounds, fixtures);

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
      /* BB1: pull the league's authoritative shared bracket. If it's newer than
         local state, applyShared() overwrites the shared fields and we re-render
         so the shared bracket shows. Silent on any failure (offline render stays). */
      try {
        fetch("data/results.json?cb=" + Date.now(), { cache: "no-store" })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (json) {
            if (json && applyShared(json)) {
              /* applyShared() persisted the league draft to localStorage but did
                 NOT touch the in-memory `state`. Refresh it (same pattern as the
                 live-results path) so this first paint renders the completed draft
                 — otherwise renderAll/applyGate run against the stale pre-draft
                 state and a fresh visitor is stuck on the locked setup view until
                 they manually reload. */
              state = loadState();
              renderAll();
              setTab(activeTab, { noScroll: true });
              toast("Updated to the league's latest bracket");
            }
          })
          .catch(function () {});
      } catch (e) { /* silent */ }
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
