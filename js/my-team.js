/* Per-viewer team identity. One hub serves the whole league, so "your
   team" is a viewer-side choice: picked from an overlay on first visit,
   stored in localStorage, or pre-set via a ?team=ABBR share link.
   Loaded right after data.js so the isMine flags are applied before the
   first render; the picker UI itself wires up on DOMContentLoaded
   (after app.js has created window.Hub).

   Knockout model: no "my group" chip and no group affiliation. Copy is
   retuned to the viewer's team, its 2 drafted countries and its points. */

(function () {
  "use strict";

  var TEAM_KEY = "wc26ko.myteam";
  var SKIP_KEY = "wc26ko.pickerSkipped";

  function store(key, val) {
    try {
      if (val == null) localStorage.removeItem(key);
      else localStorage.setItem(key, val);
    } catch (_) {} // private mode etc. — selection just won't persist
  }
  function read(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function teamByAbbr(abbr) {
    return TEAMS.find(function (t) { return t.abbr === abbr; }) || null;
  }
  function current() {
    return teamByAbbr(read(TEAM_KEY) || "");
  }

  /* Flag the chosen team on the shared TEAMS seed; every module reads
     t.isMine from there at render time. */
  function applyFlags() {
    var mine = current();
    TEAMS.forEach(function (t) { t.isMine = !!mine && t.abbr === mine.abbr; });
  }

  /* ---------------- knockout summary helpers ---------------- */

  function ctxOrNull() {
    return (window.Hub && typeof Hub.ctx === "function") ? Hub.ctx() : null;
  }

  /* The names of a team's 2 drafted countries, in pick order. */
  function draftedNames(abbr) {
    var ctx = ctxOrNull();
    if (!ctx || !ctx.draft || !ctx.draft.countriesByTeam) return [];
    var ids = ctx.draft.countriesByTeam[abbr] || [];
    var byId = (ctx.helpers && ctx.helpers.countryById) || null;
    return ids.map(function (id) {
      var c = byId ? byId(id) : null;
      return c ? c.name : id;
    });
  }

  /* The team's current standings row (points, drafted, etc.) or null. */
  function rowFor(abbr) {
    var ctx = ctxOrNull();
    if (!ctx || !ctx.standings) return null;
    return ctx.standings.find(function (r) {
      return r.team && r.team.abbr === abbr;
    }) || null;
  }

  /* A short "Country, Country · N pts" tail, or just the managers / a
     neutral fallback when the draft hasn't been made yet. */
  function summaryFor(abbr) {
    var names = draftedNames(abbr);
    var row = rowFor(abbr);
    if (names.length) {
      var tail = names.join(", ");
      if (row && typeof row.points === "number") {
        tail += " · " + (Math.round(row.points * 10) / 10) + " pts";
      }
      return tail;
    }
    var t = teamByAbbr(abbr);
    if (t && t.managers && t.managers.length) return t.managers.join(" & ");
    /* No picks and no managers. Only claim the draft is pending when the
       device has actually seen the league (an adopted feed carries a
       draftVersion; local picks mean a draft is underway) — otherwise
       we're just in the pre-sync window before data/results.json lands. */
    var st = (typeof loadState === "function" && typeof draftComplete === "function")
      ? loadState() : null;
    var synced = !!st && ((st.draftVersion || 0) > 0 || st.pickLog.length > 0);
    if (synced && !draftComplete(st)) return "Awaiting draft picks";
    return "Syncing league draft…";
  }

  function setTeam(abbr) {
    store(TEAM_KEY, abbr);
    if (abbr) store(SKIP_KEY, null);
    applyFlags();
    renderPill();
    closePicker();
    if (window.Hub) Hub.refresh();
  }

  /* ---------------- hero pill ---------------- */

  function renderPill() {
    var host = document.getElementById("hero-meta");
    if (!host) return;
    var pill = host.querySelector(".tp-pill");
    if (!pill) {
      pill = document.createElement("button");
      pill.className = "hero-pill tp-pill";
      pill.type = "button";
      pill.addEventListener("click", openPicker);
      host.appendChild(pill);
    }
    var mine = current();
    if (mine) {
      var names = draftedNames(mine.abbr);
      var row = rowFor(mine.abbr);
      var label = "🏷 You: " + mine.name;
      if (names.length) {
        label += " · " + names.join(", ");
        if (row && typeof row.points === "number") {
          label += " · " + (Math.round(row.points * 10) / 10) + " pts";
        }
      }
      pill.textContent = label;
    } else {
      pill.textContent = "🏷 Pick your team";
    }
    pill.title = "The hub highlights your drafted countries, matches and points";
  }

  /* ---------------- picker overlay ---------------- */

  var overlay = null;

  function buildPicker() {
    overlay = document.createElement("div");
    overlay.className = "tp-overlay";
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) skipPicker();
    });

    var panel = document.createElement("div");
    panel.className = "tp-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Pick your team");

    var h = document.createElement("h3");
    h.className = "tp-title";
    h.textContent = "Whose board is this?";
    panel.appendChild(h);

    var p = document.createElement("p");
    p.className = "tp-sub";
    /* Copy is owned by refreshPicker() so the pre/post-draft phrasing
       tracks the live ctx instead of being baked in at build time. */
    panel.appendChild(p);

    var grid = document.createElement("div");
    grid.className = "tp-grid";
    var mine = current();

    TEAMS.forEach(function (t) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tp-team" + (mine && mine.abbr === t.abbr ? " current" : "");

      var crest = document.createElement("span");
      crest.className = "tp-crest";
      crest.textContent = t.abbr;
      if (t.accent) crest.style.background =
        "radial-gradient(circle at 32% 28%, " + t.accent + ", #140d05)";
      btn.appendChild(crest);

      var label = document.createElement("span");
      label.className = "tp-name";
      var isCommish = (typeof LEAGUE !== "undefined") && LEAGUE.commishAbbr === t.abbr;
      label.textContent = t.name + (isCommish ? " 👑" : "");
      var grp = document.createElement("span");
      grp.className = "tp-grp";
      grp.textContent = summaryFor(t.abbr);
      label.appendChild(grp);
      btn.appendChild(label);

      btn.addEventListener("click", function () { setTeam(t.abbr); });
      grid.appendChild(btn);
    });
    panel.appendChild(grid);

    var skip = document.createElement("button");
    skip.type = "button";
    skip.className = "tp-skip";
    skip.textContent = "Just browsing";
    skip.addEventListener("click", skipPicker);
    panel.appendChild(skip);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay && !overlay.hidden) skipPicker();
    });
  }

  /* Re-sync the built panel with the latest ctx: the subtitle's pre/post-
     draft copy, each team's selection highlight and its drafted-countries
     summary. Runs on every open AND on every Hub render while the overlay
     is visible, so an open picker live-updates the moment the league sync
     lands (no stale "Awaiting draft picks" mid-tournament). */
  function refreshPicker() {
    if (!overlay) return;
    var sub = overlay.querySelector(".tp-sub");
    if (sub) {
      sub.textContent = (draftDoneCtx()
        ? "Pick your team and the hub highlights your drafted countries, knockout matches and points. "
        : "Pick your team now so the hub can highlight your picks, matches and points once the draft is done. ") +
        "Saved on this device — change it anytime from the 🏷 pill up top.";
    }
    var mine = current();
    overlay.querySelectorAll(".tp-team").forEach(function (b, i) {
      b.classList.toggle("current", !!mine && TEAMS[i].abbr === mine.abbr);
      var grp = b.querySelector(".tp-grp");
      if (grp) grp.textContent = summaryFor(TEAMS[i].abbr);
    });
  }

  function openPicker() {
    if (!overlay) buildPicker();
    refreshPicker();
    overlay.hidden = false;
    document.body.classList.add("tp-open");
  }

  function closePicker() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.classList.remove("tp-open");
  }

  function skipPicker() {
    store(SKIP_KEY, "1");
    closePicker();
  }

  /* ---------------- boot ---------------- */

  // ?team=ABBR share links assign and persist the team, then clean the URL.
  var fromUrl = new URLSearchParams(location.search).get("team");
  if (fromUrl && teamByAbbr(fromUrl.toUpperCase())) {
    store(TEAM_KEY, fromUrl.toUpperCase());
    store(SKIP_KEY, null);
    history.replaceState(null, "", location.pathname + location.hash);
  }

  applyFlags();

  /* Auto-open the picker on first visit only while the draft is still
     open (false-safe: if ctx is missing we treat the draft as not yet
     complete and still offer the picker). Once the draft is complete we
     never steal focus on load — the viewer can open it from the pill.
     Reads Hub.ctx(), NOT store state — named draftDoneCtx so it doesn't
     shadow store.js's draftComplete(state). */
  function draftDoneCtx() {
    var ctx = ctxOrNull();
    return !!(ctx && ctx.draft && ctx.draft.complete);
  }

  var autoOpened = false;
  var autoOpenTimer = null;
  document.addEventListener("DOMContentLoaded", function () {
    if (!window.Hub) return;
    Hub.onRender(function () {
      renderPill();
      /* An open picker tracks every re-render, so the league sync landing
         mid-look swaps in the real draft summaries. */
      if (overlay && !overlay.hidden) refreshPicker();
      /* Deferred auto-open: boot's first render fires BEFORE the league
         sync (data/results.json) lands, so ctx still reads "draft
         incomplete" mid-tournament. Never open at the gate directly —
         arm ONE short timer and re-check the gate against the LATEST
         ctx when it fires. Post-sync the draft reads complete and the
         picker stays closed; genuinely pre-draft (or offline) visitors
         still get it. */
      if (!autoOpened && !autoOpenTimer &&
          !current() && !read(SKIP_KEY) && !draftDoneCtx()) {
        autoOpenTimer = setTimeout(function () {
          if (!current() && !read(SKIP_KEY) && !draftDoneCtx()) {
            autoOpened = true;
            openPicker();
          }
        }, 1500);
      }
    });
  });

  window.MyTeam = { current: current, set: setTeam, open: openPicker };
})();
