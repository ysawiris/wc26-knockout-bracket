/* What-If Machine — hypothetical advancement sandbox for the knockout draft
   standings. Layers pure client-side deltas over the real standings and
   re-ranks with the same comparator as the live board (points desc, then
   wins desc). Never mutates BRACKET/TEAMS/DRAFT or any shared state. Deltas
   live in module scope + localStorage so they survive tab switches,
   auto-refresh re-renders and reloads. Steppers add hypothetical
   advancement points and round-wins per team; cards never score in the
   knockout model, so there are no card steppers, and the old PickOdds
   "forecast" prefill is gone. */

(function () {
  "use strict";

  var COPY_LABEL = "📋 Copy scenario";

  var BUMPS = {
    "inc-points": { field: "points", dir: 1 },
    "dec-points": { field: "points", dir: -1 },
    "inc-wins": { field: "wins", dir: 1 },
    "dec-wins": { field: "wins", dir: -1 }
  };

  var STORE_KEY = "wc26ko.simScenario"; // saved deltas map (fail-soft)

  var host = document.getElementById("sim-host");
  var lastCtx = null;
  var copyTimer = null;

  /* abbr -> { points, wins }. Module scope + localStorage: survives tab
     switches and re-renders like before, and reloads too. */
  var deltas = loadDeltas();

  /* ---------------- deltas ---------------- */

  function getDelta(abbr) {
    return deltas[abbr] || { points: 0, wins: 0 };
  }

  /* Single commit path for every scenario change — resets and hand-entered
     bumps all land here, so they persist identically. */
  function commitDeltas(next) {
    deltas = next;
    saveDeltas();
  }

  /* Replace the deltas map (never mutate in place); drop all-zero entries. */
  function setDelta(abbr, d) {
    var next = {};
    Object.keys(deltas).forEach(function (k) { if (k !== abbr) next[k] = deltas[k]; });
    if (d.points !== 0 || d.wins !== 0) next[abbr] = d;
    commitDeltas(next);
  }

  /* ---------------- storage (fail-soft, like js/race.js) ---------------- */

  function loadDeltas() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return {};
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return {};
      var out = {};
      Object.keys(obj).forEach(function (k) {
        var d = obj[k] || {};
        var p = d.points | 0;
        var w = d.wins | 0;
        if (p !== 0 || w !== 0) out[k] = { points: p, wins: w };
      });
      return out;
    } catch (err) {
      return {}; /* bad JSON or no storage — start clean */
    }
  }

  function saveDeltas() {
    try {
      if (Object.keys(deltas).length) {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(deltas));
      } else {
        window.localStorage.removeItem(STORE_KEY);
      }
    } catch (err) { /* private mode — scenario just won't survive reloads */ }
  }

  function tweakCount() {
    return Object.keys(deltas).reduce(function (s, k) {
      var d = deltas[k];
      return s + Math.abs(d.points) + Math.abs(d.wins);
    }, 0);
  }

  /* ---------------- simulated standings ---------------- */

  /* Same comparator as the real board (points desc, then wins desc), made
     explicitly stable by falling back to the real-order index. */
  function buildSimRows() {
    var rows = lastCtx.standings.map(function (row, i) {
      var d = getDelta(row.team.abbr);
      return {
        base: row,
        realIndex: i,
        delta: d,
        simPoints: Math.max(0, (row.points || 0) + d.points),
        simWins: Math.max(0, (row.wins || 0) + d.wins)
      };
    });
    var sorted = rows.slice().sort(function (a, b) {
      if (b.simPoints !== a.simPoints) return b.simPoints - a.simPoints;
      if (b.simWins !== a.simWins) return b.simWins - a.simWins;
      return a.realIndex - b.realIndex;
    });
    return sorted.map(function (row, i) {
      var same = function (o) { return o && o.simPoints === row.simPoints && o.simWins === row.simWins; };
      return Object.assign({}, row, { tied: same(sorted[i - 1]) || same(sorted[i + 1]) });
    });
  }

  /* ---------------- render ---------------- */

  function signedChip(n) {
    if (!n) return "";
    return '<span class="sim-delta">' + (n > 0 ? "+" : "−") + Math.abs(n) + "</span>";
  }

  /* Trim a float total for display: whole numbers show plain, fractional
     (goal-bonus) totals show one decimal. */
  function fmtNum(n) {
    return n % 1 === 0 ? String(n) : n.toFixed(1);
  }

  function stepHtml(t, esc, kind, icon, incAct, decAct, addLabel, removeLabel, decDisabled) {
    var who = t.name + " (" + t.abbr + ")";
    return '<span class="sim-step sim-step-' + kind + '">' +
      '<button type="button" class="sim-sbtn" data-act="' + decAct + '" data-abbr="' + esc(t.abbr) + '"' +
        ' aria-label="' + esc(removeLabel + " " + who) + '"' + (decDisabled ? " disabled" : "") + ">−</button>" +
      '<span class="sim-sicon" aria-hidden="true">' + icon + "</span>" +
      '<button type="button" class="sim-sbtn" data-act="' + incAct + '" data-abbr="' + esc(t.abbr) + '"' +
        ' aria-label="' + esc(addLabel + " " + who) + '">+</button>' +
      "</span>";
  }

  /* Two flag emoji for the team's drafted countries (knockout swap for the
     old "Grp X" chip). Empty pre-draft, when drafted is []. */
  function flagsHtml(row, esc) {
    if (!row.drafted || !row.drafted.length) return "";
    return row.drafted.map(function (c) {
      return '<span class="sim-flag" title="' + esc(c.name) + '">' + esc(c.flag) + "</span>";
    }).join("");
  }

  function rowHtml(sim, simIndex, showTies) {
    var esc = lastCtx.helpers.esc;
    var t = sim.base.team;
    var d = sim.delta;
    var touched = d.points !== 0 || d.wins !== 0;
    var move = sim.realIndex - simIndex;

    var moveHtml = move > 0
      ? '<span class="sim-move up" title="Up ' + move + ' from the real order">▲' + move + "</span>"
      : move < 0
        ? '<span class="sim-move down" title="Down ' + (-move) + ' from the real order">▼' + (-move) + "</span>"
        : '<span class="sim-move flat" title="Same as the real order">·</span>';

    var you = t.isMine ? '<span class="sim-you">You</span>' : "";
    var tied = showTies && sim.tied ? '<span class="sim-tied">Tied</span>' : "";
    var accent = t.accent ? ' style="--ac:' + esc(t.accent) + '"' : "";

    /* Row label: "Pick #<real rank> · <team> (<2 country flags>)". The pick
       slot is the team's draft-order position (its real standings rank). */
    var pickLabel = "Pick #" + (sim.base.rank || sim.realIndex + 1);

    return '<li class="sim-row' + (t.isMine ? " sim-mine" : "") + (touched ? " sim-touched" : "") + '"' + accent + ">" +
      '<div class="sim-rankcol"><span class="sim-rank">' + (simIndex + 1) + "</span>" + moveHtml + "</div>" +
      '<div class="sim-main">' +
        '<div class="sim-top">' +
          '<span class="sim-pick">' + esc(pickLabel) + "</span>" +
          '<span class="sim-name">' + esc(t.name) + "</span>" + you + tied +
          '<span class="sim-flags">' + flagsHtml(sim.base, esc) + "</span>" +
        "</div>" +
        '<div class="sim-nums">' +
          '<span class="sim-num"><small>PTS</small><b>' + fmtNum(sim.simPoints) + "</b>" + signedChip(d.points) + "</span>" +
          '<span class="sim-num"><small>W</small><b>' + sim.simWins + "</b>" + signedChip(d.wins) + "</span>" +
        "</div>" +
      "</div>" +
      '<div class="sim-steppers">' +
        stepHtml(t, esc, "points", "📈", "inc-points", "dec-points", "Add an advancement point to", "Remove an advancement point from", sim.simPoints < 1) +
        stepHtml(t, esc, "wins", "🏆", "inc-wins", "dec-wins", "Add a round win to", "Remove a round win from", sim.simWins < 1) +
      "</div>" +
      "</li>";
  }

  function renderSim() {
    if (!host || !lastCtx) return;

    var sims = buildSimRows();
    var count = tweakCount();
    var teamsTouched = Object.keys(deltas).length;
    /* Pre-draft everyone sits on 0; don't spam "Tied" on every row until
       either the bracket starts or the user starts fiddling. */
    var showTies = lastCtx.started || count > 0;

    var note = count
      ? count + " tweak" + (count === 1 ? "" : "s") + " on " + teamsTouched +
        " team" + (teamsTouched === 1 ? "" : "s") + " — order below is hypothetical."
      : "No tweaks yet — this mirrors the real board.";

    host.innerHTML =
      '<p class="sim-presets-hint">Add hypothetical advancement points and round wins to any team, then watch the draft order re-rank. Cards never score in the knockout — only advancement and goals do.</p>' +
      '<div class="sim-bar">' +
        '<button type="button" class="sim-btn sim-reset" data-act="reset"' + (count ? "" : " disabled") + ">↺ Reset</button>" +
        '<button type="button" class="sim-btn sim-copy" data-act="copy">' + COPY_LABEL + "</button>" +
        '<span class="sim-note">' + note + "</span>" +
      "</div>" +
      '<ol class="sim-board">' +
        sims.map(function (sim, i) { return rowHtml(sim, i, showTies); }).join("") +
      "</ol>" +
      '<p class="sim-foot">Sorted by points, then round wins. Scenarios live only in your browser.</p>';
  }

  /* ---------------- copy scenario ---------------- */

  function signedWords(n, word) {
    var abs = Math.abs(n);
    return (n > 0 ? "+" : "−") + abs + " " + word + (abs === 1 ? "" : "s");
  }

  function scenarioSummary() {
    var parts = [];
    lastCtx.standings.forEach(function (row) {
      var d = deltas[row.team.abbr];
      if (!d) return;
      var bits = [];
      if (d.points) bits.push(signedWords(d.points, "pt"));
      if (d.wins) bits.push(signedWords(d.wins, "win"));
      parts.push(row.team.abbr + " " + bits.join(" "));
    });
    return parts.length
      ? "Scenario: " + parts.join(", ")
      : "Scenario: no tweaks — same as the real board.";
  }

  function scenarioText() {
    var sims = buildSimRows();
    var lines = ["🔮 What-If draft order — " + LEAGUE.name];
    sims.forEach(function (sim, i) {
      var move = sim.realIndex - i;
      var arrow = move > 0 ? " ▲" + move : move < 0 ? " ▼" + (-move) : "";
      lines.push((i + 1) + ". " + sim.base.team.name + " — " + fmtNum(sim.simPoints) + " pts · " + sim.simWins + " wins" + arrow);
    });
    lines.push("");
    lines.push(scenarioSummary());
    lines.push("(Hypothetical — the real board is untouched.)");
    return lines.join("\n");
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      document.body.removeChild(ta);
      if (ok) resolve();
      else reject(new Error("copy failed"));
    });
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }

  function handleCopy(btn) {
    writeClipboard(scenarioText()).then(function () {
      if (copyTimer) clearTimeout(copyTimer);
      btn.textContent = "Copied ✓";
      btn.classList.add("is-copied");
      copyTimer = setTimeout(function () {
        btn.textContent = COPY_LABEL;
        btn.classList.remove("is-copied");
        copyTimer = null;
      }, 1600);
    }).catch(function () {
      btn.textContent = "Copy failed";
      setTimeout(function () { btn.textContent = COPY_LABEL; }, 1600);
    });
  }

  /* ---------------- interactions ---------------- */

  function applyBump(abbr, act) {
    var bump = BUMPS[act];
    if (!bump || !abbr) return;
    var row = null;
    lastCtx.standings.forEach(function (r) { if (r.team.abbr === abbr) row = r; });
    if (!row) return;

    var d = getDelta(abbr);
    var next = { points: d.points, wins: d.wins };
    next[bump.field] = next[bump.field] + bump.dir;

    /* Clamp: simulated totals never drop below zero. */
    if ((row.points || 0) + next.points < 0) return;
    if ((row.wins || 0) + next.wins < 0) return;

    setDelta(abbr, next);
    renderSim();
  }

  /* Re-render rebuilds the DOM, which drops keyboard focus — put it back on
     the equivalent button so steppers stay usable without a mouse. */
  function refocus(act, abbr) {
    var btns = host.querySelectorAll('[data-act="' + act + '"]');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute("data-abbr") === abbr && !btns[i].disabled) {
        btns[i].focus();
        return;
      }
    }
  }

  /* ONE delegated listener, attached once at module load; renderSim() only
     ever swaps innerHTML, so no listeners stack across re-renders. */
  if (host) {
    host.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-act]") : null;
      if (!btn || btn.disabled || !lastCtx) return;
      var act = btn.getAttribute("data-act");
      if (act === "reset") {
        commitDeltas({});
        renderSim();
      } else if (act === "copy") {
        handleCopy(btn);
      } else {
        var abbr = btn.getAttribute("data-abbr");
        applyBump(abbr, act);
        refocus(act, abbr);
      }
    });
  }

  if (window.Hub) {
    Hub.onRender(function (ctx) {
      if (!ctx || !ctx.standings || !ctx.bracket || !ctx.draft) return;
      lastCtx = ctx;
      renderSim();
    });
  }
})();
