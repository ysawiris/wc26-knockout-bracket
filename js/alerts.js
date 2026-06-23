/* Knockout alerts — watches consecutive Hub renders and announces what
   changed in the bracket: goals (with the fantasy team(s) that drafted the
   scoring nation), round advancements (+points), eliminations, a new league
   #1, and the eventual champion. Toasts stack bottom-right; an optional
   "notify" mode adds browser notifications plus a short synthesized goal horn
   when the tab is hidden. A bell button in the top nav cycles on → notify →
   off (persisted in localStorage "wc26.alerts"). The first render after page
   load only seeds the baseline snapshot, so opening the page never causes a
   toast storm. Everything fails soft: a broken alert never breaks the hub. */

(function () {
  "use strict";

  var STORE_KEY = "wc26.alerts";
  var BOOT_QUIET_MS = 15000; /* silence diffs this long after load — the
    direct-FIFA layer bootstraps a few seconds in and would otherwise present
    every result since the last cron commit (up to ~10 min old) as breaking
    news */
  var TOAST_MS = 7000;
  var TOAST_OUT_MS = 260;
  var MAX_TOASTS = 4;   /* per render cycle; extras collapse into one toast */
  var MAX_STACKED = 6;  /* hard cap on toasts in the DOM at once */
  var FLASH_MS = 3000;

  var INPLAY = (window.Live && window.Live.INPLAY) ||
    { IN_PLAY: 1, PAUSED: 1, LIVE: 1, HALFTIME: 1 };
  var FINISHED = (window.Live && window.Live.FINISHED) ||
    { FINISHED: 1, AWARDED: 1 };

  /* All mutable state lives in module scope so it survives the ~2-minute
     auto re-renders — the DOM is rebuilt from it on every pass. */
  var mode = readMode();    /* "on" | "notify" | "off" */
  var prevSnap = null;      /* snapshot of the previous render; null = unseeded */
  var bootAt = Date.now();  /* module load time — anchors the boot quiet window */
  var stack = null;         /* toast container appended to document.body */
  var audioCtx = null;      /* lazy AudioContext — created only after a user gesture */
  var flashUntil = {};      /* team abbr -> epoch ms when the board-row flash expires */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------------- mode persistence (fail-soft) ---------------- */

  function readMode() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (raw === "on" || raw === "notify" || raw === "off") return raw;
    } catch (err) { /* private mode — default below */ }
    return "on";
  }

  function setMode(next) {
    mode = next;
    try { window.localStorage.setItem(STORE_KEY, next); } catch (err) { /* fine */ }
    paintBell();
  }

  /* ---------------- bell toggle (inserted once, guarded by id) ---------------- */

  function ensureBell() {
    if (document.getElementById("ga-bell")) return;
    var nav = document.querySelector(".topnav");
    if (!nav) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "ga-bell";
    btn.className = "ga-bell";
    btn.addEventListener("click", onBellClick);
    /* #tabs is the last child of .topnav, so appending lands right after it. */
    nav.appendChild(btn);
    paintBell();
  }

  function paintBell() {
    var btn = document.getElementById("ga-bell");
    if (!btn) return;
    var title;
    btn.classList.remove("is-notify", "is-off");
    if (mode === "notify") {
      btn.textContent = "🔔";
      btn.classList.add("is-notify");
      title = "Knockout alerts: toasts + browser notifications + horn · tap to mute";
    } else if (mode === "off") {
      btn.textContent = "🔕";
      btn.classList.add("is-off");
      title = "Knockout alerts: off · tap to turn on";
    } else {
      btn.textContent = "🔔";
      title = "Knockout alerts: in-page toasts · tap to add browser notifications";
    }
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.setAttribute("aria-pressed", mode === "off" ? "false" : "true");
  }

  function onBellClick() {
    try {
      if (mode === "on") {
        if (!("Notification" in window) || Notification.permission === "denied") {
          /* Notify mode is unreachable — skip straight to mute. */
          setMode("off");
          showToast("🔕 Alerts off", "No more toasts. Tap the bell to turn them back on.", "info");
        } else {
          enterNotifyMode();
        }
      } else if (mode === "notify") {
        setMode("off");
        showToast("🔕 Alerts off", "No more toasts or notifications.", "info");
      } else {
        setMode("on");
        showToast("🔔 Alerts on", "Goal, advancement and standings toasts while the hub is open.", "info");
      }
    } catch (err) {
      console.error("Knockout alerts bell failed:", err);
    }
  }

  function enterNotifyMode() {
    ensureAudio(); /* user gesture — safe moment to unlock the horn */
    if (Notification.permission === "granted") {
      setMode("notify");
      showToast("🔔 Browser alerts on", "Goal horn + system pings while the hub stays open in a background tab or window.", "info");
      return;
    }
    requestPermission(function (perm) {
      if (perm === "granted") {
        setMode("notify");
        showToast("🔔 Browser alerts on", "Goal horn + system pings while the hub stays open in a background tab or window.", "info");
      } else {
        setMode("on");
        showToast("🔔 Toasts only", "Notification permission was denied — staying on in-page alerts.", "info");
      }
    });
  }

  /* Old Safari uses the callback form, modern browsers return a Promise —
     handle both, exactly once. */
  function requestPermission(done) {
    var handled = false;
    function finish(perm) {
      if (handled) return;
      handled = true;
      done(perm);
    }
    try {
      var maybe = Notification.requestPermission(function (perm) { finish(perm); });
      if (maybe && typeof maybe.then === "function") {
        maybe.then(finish).catch(function () { finish("default"); });
      }
    } catch (err) {
      finish("default");
    }
  }

  /* ---------------- toast stack ---------------- */

  function ensureStack() {
    if (stack && stack.parentNode) return;
    var existing = document.getElementById("ga-stack");
    if (existing) { stack = existing; return; }
    if (!document.body) return;
    stack = document.createElement("div");
    stack.id = "ga-stack";
    stack.className = "ga-stack";
    stack.setAttribute("aria-live", "polite");
    stack.addEventListener("click", function (e) {
      /* The hype button carries its own payload; fire ShareCard and swallow
         the click so it doesn't also dismiss the toast. */
      var hype = e.target.closest(".ga-hype");
      if (hype) {
        e.stopPropagation();
        fireHype(hype);
        return;
      }
      var t = e.target.closest(".ga-toast");
      if (t) dismissToast(t);
    });
    document.body.appendChild(stack);
  }

  function showToast(title, sub, kind, hype) {
    ensureStack();
    if (!stack) return;
    while (stack.children.length >= MAX_STACKED) {
      stack.removeChild(stack.firstChild);
    }
    var t = document.createElement("div");
    t.className = "ga-toast" + (kind ? " ga-" + kind : "");
    t.setAttribute("role", "status");
    var html = '<div class="ga-title">' + esc(title) + "</div>";
    if (sub) html += '<div class="ga-sub">' + esc(sub) + "</div>";
    /* Surface a hype-card button on event toasts when ShareCard is loaded.
       The payload is stashed on the button as JSON so the delegated stack
       click handler can hand it straight to ShareCard.hype(ev). */
    if (hype && hasShareCard()) {
      html += '<button type="button" class="ga-hype" title="Make a share card" ' +
        'aria-label="Make a share card" data-ga-hype="' +
        esc(JSON.stringify(hype)) + '">📸</button>';
    }
    t.innerHTML = html;
    stack.appendChild(t);
    window.setTimeout(function () { dismissToast(t); }, TOAST_MS);
  }

  /* ShareCard is an optional sibling module — never assume it loaded. */
  function hasShareCard() {
    return !!(window.ShareCard && typeof window.ShareCard.hype === "function");
  }

  function fireHype(btn) {
    if (!hasShareCard()) return;
    var raw = btn.getAttribute("data-ga-hype");
    if (!raw) return;
    try {
      window.ShareCard.hype(JSON.parse(raw));
    } catch (err) {
      console.error("Knockout alerts hype card failed:", err);
    }
  }

  function dismissToast(t) {
    if (!t || !t.parentNode || t.getAttribute("data-ga-out")) return;
    t.setAttribute("data-ga-out", "1");
    t.classList.add("ga-out");
    window.setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, TOAST_OUT_MS);
  }

  /* ---------------- browser notifications ---------------- */

  function notifyBrowser(title, body, tag) {
    if (mode !== "notify") return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (!document.hidden) return; /* the toast already covers a visible tab */
    try {
      new Notification(title, {
        body: body || "",
        tag: "wc26-" + tag,
        icon: "assets/icon.svg"
      });
    } catch (err) {
      /* Some platforms require a ServiceWorker — notifications just stay off. */
    }
  }

  /* ---------------- goal horn (Web Audio, no asset) ---------------- */

  function ensureAudio() {
    try {
      if (audioCtx) {
        if (audioCtx.state === "suspended") audioCtx.resume();
        return;
      }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } catch (err) {
      audioCtx = null;
    }
  }

  function hornNote(freq, at, dur) {
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  function playHorn() {
    if (mode !== "notify" || !audioCtx) return;
    try {
      if (audioCtx.state === "suspended") audioCtx.resume();
      if (audioCtx.state !== "running") return;
      var now = audioCtx.currentTime;
      hornNote(392, now, 0.18);          /* G4 */
      hornNote(523.25, now + 0.2, 0.22); /* C5 — two-note rise, ~0.4s total */
    } catch (err) {
      /* Horn is best-effort decoration. */
    }
  }

  /* If notify mode was restored from storage, arm a one-time gesture
     listener so the horn's AudioContext gets unlocked by the first tap. */
  if (mode === "notify") {
    var unlockAudio = function () {
      document.removeEventListener("click", unlockAudio, true);
      if (mode === "notify") ensureAudio();
    };
    document.addEventListener("click", unlockAudio, true);
  }

  /* ---------------- snapshot + diff ---------------- */

  /* Flatten the hierarchical bracket (rounds → matches) into one pass so the
     diff can scan every match regardless of round, while keeping each match's
     round metadata (label, points) attached for the toast copy. */
  function eachMatch(ctx, fn) {
    var rounds = (ctx.bracket && ctx.bracket.rounds) || [];
    rounds.forEach(function (round) {
      var matches = round.matches || [];
      matches.forEach(function (mt) { fn(mt, round); });
    });
  }

  function num(v) { return v == null ? 0 : v; }

  function snapMatch(mt) {
    return {
      hg: num(mt.homeGoals),
      ag: num(mt.awayGoals),
      winnerId: mt.winnerId || null,
      counted: !!(INPLAY[mt.status] || FINISHED[mt.status])
    };
  }

  /* Keyed by match id (NOT group — there are no groups in the knockout).
     ranks/advance/alive are per-team, used by diffRanks. */
  function buildSnapshot(ctx) {
    var snap = { matches: {}, ranks: {}, advance: {}, alive: {} };
    eachMatch(ctx, function (mt) {
      if (!mt.id) return;
      snap.matches[mt.id] = snapMatch(mt);
    });
    ctx.standings.forEach(function (row) {
      var abbr = row.team && row.team.abbr;
      if (!abbr) return;
      snap.ranks[abbr] = row.rank;
      snap.advance[abbr] = num(row.advancePoints);
      snap.alive[abbr] = num(row.aliveCount);
    });
    return snap;
  }

  /* Counters only ever ratchet UP in the stored baseline: when the data
     source briefly downgrades (direct overlay expires, cron lags), a rewound
     score must not re-fire the same goal once the better source returns.
     ranks/advance/alive always take the latest values (they are re-derived). */
  function mergeHighWater(prev, snap) {
    var merged = { matches: {}, ranks: snap.ranks, advance: snap.advance, alive: snap.alive };
    Object.keys(snap.matches).forEach(function (key) {
      var cur = snap.matches[key];
      var old = prev.matches[key];
      merged.matches[key] = !old ? cur : {
        hg: Math.max(cur.hg, old.hg),
        ag: Math.max(cur.ag, old.ag),
        /* Keep a winner once one has been seen — results don't un-happen. */
        winnerId: cur.winnerId || old.winnerId,
        counted: cur.counted || old.counted
      };
    });
    return merged;
  }

  /* Resolve the fantasy team that drafted a country (or null) via the draft
     owner map. A match can have up to two owning teams (one per side). */
  function ownerAbbr(ctx, countryId) {
    if (!countryId) return null;
    var owners = (ctx.draft && ctx.draft.ownersByCountry) || {};
    return owners[countryId] || null;
  }

  function teamName(ctx, abbr) {
    if (!abbr) return null;
    var teams = ctx.teams || [];
    for (var i = 0; i < teams.length; i++) {
      if (teams[i].abbr === abbr) return teams[i].name;
    }
    return abbr;
  }

  function countryName(ctx, countryId) {
    if (!countryId) return null;
    var byId = ctx.field && ctx.field.byId;
    if (byId && byId[countryId]) return byId[countryId].name;
    if (ctx.helpers && ctx.helpers.countryById) {
      var c = ctx.helpers.countryById(countryId);
      if (c) return c.name;
    }
    return null;
  }

  /* Standings rank / advancement diffs. Fires on advancePoints climbs
     ("advances / +points") and crowns a brand-new #1 with 👑. */
  function diffRanks(prev, ctx) {
    var events = [];
    var rankChanges = [];
    var newLeader = null;

    ctx.standings.forEach(function (row) {
      var abbr = row.team && row.team.abbr;
      if (!abbr) return;
      var wasRank = prev.ranks[abbr];
      var wasAdv = prev.advance[abbr];
      var nowAdv = num(row.advancePoints);

      if (typeof wasRank === "number" && wasRank !== row.rank) {
        rankChanges.push({ abbr: abbr, from: wasRank, to: row.rank });
        if (row.rank === 1 && wasRank > 1) newLeader = { abbr: abbr, points: row.points };
      }
      /* Advancement gained points since last render → a drafted country won a
         round. Announce once per team, with the new running total. */
      if (typeof wasAdv === "number" && nowAdv > wasAdv) {
        var name = teamName(ctx, abbr) || abbr;
        events.push({
          kind: "advance", tag: "advance-" + abbr + "-" + nowAdv,
          title: "📈 " + abbr + " advances · +" + (nowAdv - wasAdv) + " pts",
          sub: name + " — " + row.points + " pts total · reached " + (row.reached || "—"),
          hype: {
            kind: "advance", teamAbbr: abbr, countryId: null,
            roundLabel: row.reached || null, points: nowAdv - wasAdv,
            note: name + " — " + row.points + " pts total"
          }
        });
      }
    });

    if (newLeader) {
      events.push({
        kind: "champion", tag: "leader-" + newLeader.abbr,
        title: "👑 " + newLeader.abbr + " takes #1!",
        sub: (teamName(ctx, newLeader.abbr) || newLeader.abbr) + " leads with " + newLeader.points + " pts",
        hype: {
          kind: "rank", teamAbbr: newLeader.abbr, countryId: null,
          roundLabel: "#1", points: newLeader.points,
          note: (teamName(ctx, newLeader.abbr) || newLeader.abbr) + " takes the lead"
        }
      });
    } else if (rankChanges.length) {
      rankChanges.sort(function (a, b) { return a.to - b.to; });
      var parts = rankChanges.map(function (c) {
        return c.abbr + (c.to < c.from ? " up to #" : " down to #") + c.to;
      });
      events.push({ kind: "rank", tag: "rank", title: "📊 New order", sub: parts.join(", ") });
    }
    return events;
  }

  function diffRenders(prev, ctx) {
    var goals = [];
    var results = [];

    eachMatch(ctx, function (mt, round) {
      if (!mt.id) return;
      var p = prev.matches[mt.id];
      if (!p) return;
      var cur = snapMatch(mt);
      /* Skip matches that went straight from "not started" to FINISHED —
         we were away the whole match, that's not breaking news. */
      if (!p.counted && FINISHED[mt.status]) return;

      var homeName = mt.home.name || countryName(ctx, mt.home.countryId) || "TBD";
      var awayName = mt.away.name || countryName(ctx, mt.away.countryId) || "TBD";
      var homeOwner = ownerAbbr(ctx, mt.home.countryId);
      var awayOwner = ownerAbbr(ctx, mt.away.countryId);

      /* --- goals (flash BOTH owning teams' board rows) --- */
      var dGoals = (cur.hg - p.hg) + (cur.ag - p.ag);
      if (dGoals > 0) {
        var ownerBits = [];
        if (homeOwner) ownerBits.push(teamName(ctx, homeOwner) || homeOwner);
        if (awayOwner) ownerBits.push(teamName(ctx, awayOwner) || awayOwner);
        var goalSub = (round.label || mt.round) + " · " +
          (ownerBits.length ? "drafted by " + ownerBits.join(" & ") : "no fantasy team drafted these");
        goals.push({ kind: "goal",
          tag: "goal-" + mt.id + "-" + cur.hg + "-" + cur.ag,
          title: "⚽ GOAL — " + homeName + " " + cur.hg + "–" + cur.ag + " " + awayName,
          sub: goalSub });
        if (homeOwner) flashUntil[homeOwner] = Date.now() + FLASH_MS;
        if (awayOwner) flashUntil[awayOwner] = Date.now() + FLASH_MS;
      }

      /* --- a winner was newly decided (round advancement / elimination) --- */
      if (cur.winnerId && cur.winnerId !== p.winnerId) {
        var winName = countryName(ctx, cur.winnerId) ||
          (cur.winnerId === mt.home.countryId ? homeName : awayName);
        var winOwner = ownerAbbr(ctx, cur.winnerId);
        var loserId = cur.winnerId === mt.home.countryId ? mt.away.countryId : mt.home.countryId;
        var loseOwner = ownerAbbr(ctx, loserId);
        var pts = round.points || 0;

        results.push({ kind: "advance",
          tag: "result-" + mt.id + "-" + cur.winnerId,
          title: "✅ " + winName + " advance" + (round.label ? " — " + round.label : ""),
          sub: winOwner
            ? (teamName(ctx, winOwner) || winOwner) + " +" + pts + " pts"
            : "Undrafted — no fantasy points",
          hype: {
            kind: "advance", teamAbbr: winOwner || null, countryId: cur.winnerId,
            roundLabel: round.label || mt.round || null, points: pts,
            note: winName + " advance" + (round.label ? " — " + round.label : "")
          } });

        if (loseOwner && loseOwner !== winOwner) {
          var loseName = countryName(ctx, loserId) ||
            (loserId === mt.home.countryId ? homeName : awayName);
          results.push({ kind: "eliminate",
            tag: "out-" + mt.id + "-" + loserId,
            title: "❌ " + loseName + " eliminated",
            sub: (teamName(ctx, loseOwner) || loseOwner) + "'s drafted country is out",
            hype: {
              kind: "eliminate", teamAbbr: loseOwner || null, countryId: loserId,
              roundLabel: round.label || mt.round || null, points: 0,
              note: loseName + " eliminated"
            } });
        }
      }
    });

    var events = goals.concat(results);

    /* Standings-driven events (rank shuffles, advancement totals, new #1). */
    events = events.concat(diffRanks(prev, ctx));

    /* Champion: a team whose drafted country just reached "Champion" wins it. */
    ctx.standings.forEach(function (row) {
      var abbr = row.team && row.team.abbr;
      if (!abbr) return;
      if (row.reached === "Champion" && prev.advance[abbr] != null &&
          num(row.advancePoints) > num(prev.advance[abbr])) {
        events.push({ kind: "champion", tag: "champ-" + abbr,
          title: "🏆 " + abbr + " wins the World Cup!",
          sub: (teamName(ctx, abbr) || abbr) + "'s drafted country lifts the trophy",
          hype: {
            kind: "champion", teamAbbr: abbr, countryId: null,
            roundLabel: "Champion", points: num(row.advancePoints) - num(prev.advance[abbr]),
            note: (teamName(ctx, abbr) || abbr) + " wins the World Cup"
          } });
      }
    });

    return events;
  }

  /* ---------------- announce (cap + collapse) ---------------- */

  function announce(events) {
    if (!events.length) return;
    var shown = events;
    var rest = [];
    if (events.length > MAX_TOASTS) {
      shown = events.slice(0, MAX_TOASTS - 1);
      rest = events.slice(MAX_TOASTS - 1);
    }
    shown.forEach(function (ev) {
      showToast(ev.title, ev.sub, ev.kind, ev.hype);
      notifyBrowser(ev.title, ev.sub, ev.tag);
    });
    if (rest.length) {
      var nGoals = 0;
      rest.forEach(function (ev) { if (ev.kind === "goal") nGoals += 1; });
      var nOther = rest.length - nGoals;
      var bits = [];
      if (nGoals) bits.push("+" + nGoals + " more " + (nGoals === 1 ? "goal" : "goals"));
      if (nOther) bits.push("+" + nOther + " more " + (nOther === 1 ? "update" : "updates"));
      var title = "⚽ " + bits.join(" · ");
      showToast(title, "", "more");
      notifyBrowser(title, "", "more");
    }
    var hasGoal = events.some(function (ev) { return ev.kind === "goal"; });
    if (hasGoal) playHorn();
  }

  /* ---------------- board-row goal flash ---------------- */

  function removeFlash(abbr) {
    var list = document.getElementById("board-list");
    if (!list) return;
    Array.prototype.forEach.call(list.querySelectorAll("li.row.goal-flash"), function (li) {
      if (li.dataset.abbr === abbr) li.classList.remove("goal-flash");
    });
  }

  /* Re-applied every render because app.js rebuilds #board-list each pass. */
  function applyFlashes() {
    var list = document.getElementById("board-list");
    if (!list) return;
    var now = Date.now();
    Array.prototype.forEach.call(list.querySelectorAll("li.row[data-abbr]"), function (li) {
      var abbr = li.dataset.abbr;
      var until = flashUntil[abbr];
      if (!until) return;
      if (until <= now) {
        delete flashUntil[abbr];
        li.classList.remove("goal-flash");
        return;
      }
      li.classList.add("goal-flash");
      window.setTimeout(function () {
        if ((flashUntil[abbr] || 0) <= Date.now()) {
          delete flashUntil[abbr];
          removeFlash(abbr);
        }
      }, until - now + 30);
    });
  }

  /* ---------------- entry point ---------------- */

  function render(ctx) {
    try {
      ensureBell();
      ensureStack();
      if (!ctx || !ctx.bracket || !ctx.draft || !ctx.standings) return;
      var snap = buildSnapshot(ctx);
      var prev = prevSnap;
      /* Roll forward on every path (even muted) with ratcheted counters so
         a data-source downgrade can never rewind the baseline. */
      prevSnap = prev ? mergeHighWater(prev, snap) : snap;
      if (!prev) return; /* baseline render — seed only, never alert */
      if (mode === "off") return;
      if (Date.now() - bootAt < BOOT_QUIET_MS) return; /* boot quiet window —
        re-seed silently while the direct layer catches up the cron lag */
      announce(diffRenders(prev, ctx));
      applyFlashes();
    } catch (err) {
      console.error("Knockout alerts failed:", err);
    }
  }

  if (window.Hub && typeof window.Hub.onRender === "function") {
    window.Hub.onRender(render);
  }
})();
