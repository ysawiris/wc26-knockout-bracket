/* ============================================================
   BB4 — Champion ceremony. A one-time, full-screen celebration
   overlay that fires the moment the bracket produces a champion:
   the winning country's flag, "CHAMPIONS", the drafting team's
   name and its final points, and pure-CSS/JS confetti.

   Self-contained Hub.onRender module — creates its own DOM, no
   host div needed. The champion is resolved from the Final round's
   decided match (ctx.bracket last round winnerId), then the owning
   team + its total points are read off ctx.standings / ctx.draft.

   Shows ONCE per champion: a localStorage flag ("wc26ko.ceremony"
   = championId) is written on close (or first show) and re-checked
   every render, so it never re-fires on a re-render or reload — it
   only re-opens if the champion country actually changes.

   Confetti + the flag pop respect @media (prefers-reduced-motion:
   reduce) via css/ceremony.css; the JS also skips spawning confetti
   nodes when reduced motion is requested. The "📸 Share the
   champion" button calls window.ShareCard.hype({kind:"champion",…})
   when that helper is present, and is hidden otherwise.
   ============================================================ */

(function () {
  "use strict";

  var STORE_KEY = "wc26ko.ceremony";
  var CONFETTI_COUNT = 90;
  var CONFETTI_COLORS = ["#fdf3cf", "#efd185", "#c89638", "#f7e3a6", "#f4ede0"];

  /* The overlay is a singleton; module scope survives re-renders. */
  var overlay = null;
  var shownChampionId = null;

  /* ---------------- localStorage (defensive) ---------------- */

  function readSeen() {
    try {
      return window.localStorage ? window.localStorage.getItem(STORE_KEY) : null;
    } catch (err) {
      return null;
    }
  }

  function writeSeen(championId) {
    try {
      if (window.localStorage) window.localStorage.setItem(STORE_KEY, String(championId));
    } catch (err) {
      /* private mode / quota — degrade to in-memory only */
    }
  }

  /* ---------------- champion resolution ---------------- */

  /* The champion is the winner of the Final — the last bracket round.
     Returns the winning countryId, or null if the final is not decided. */
  function championId(ctx) {
    var rounds = (ctx.bracket && ctx.bracket.rounds) || [];
    if (!rounds.length) return null;

    /* Prefer an explicit "Final" round; otherwise the deepest round. */
    var finalRound = null;
    var i;
    for (i = 0; i < rounds.length; i++) {
      if (rounds[i] && rounds[i].name === "Final") finalRound = rounds[i];
    }
    if (!finalRound) finalRound = rounds[rounds.length - 1];
    if (!finalRound) return null;

    var matches = finalRound.matches || [];
    var m;
    for (i = 0; i < matches.length; i++) {
      m = matches[i];
      if (m && m.winnerId) return m.winnerId;
    }
    return null;
  }

  function resolveCountry(ctx, id) {
    var byId = (ctx.field && ctx.field.byId) || {};
    return byId[id] || (ctx.helpers && ctx.helpers.countryById && ctx.helpers.countryById(id)) || null;
  }

  /* The owning team abbreviation for a drafted country. */
  function ownerAbbr(ctx, id) {
    var owners = (ctx.draft && ctx.draft.ownersByCountry) || {};
    if (owners[id]) return owners[id];
    if (ctx.helpers && typeof ctx.helpers.countryTeamOwner === "function") {
      return ctx.helpers.countryTeamOwner(id) || null;
    }
    return null;
  }

  /* The standings row for the owning team — gives the final points + name. */
  function ownerRow(ctx, abbr) {
    if (!abbr) return null;
    var rows = ctx.standings || [];
    var i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].team && rows[i].team.abbr === abbr) return rows[i];
    }
    return null;
  }

  /* Points print as an integer unless there is a fractional goal bonus. */
  function fmtPoints(pts) {
    if (typeof pts !== "number" || isNaN(pts)) return "0";
    return pts % 1 !== 0 ? pts.toFixed(1) : String(pts);
  }

  /* ---------------- confetti ---------------- */

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (err) {
      return false;
    }
  }

  function spawnConfetti(layer) {
    if (prefersReducedMotion()) return; /* CSS also disables the animation */
    var i;
    for (i = 0; i < CONFETTI_COUNT; i++) {
      var piece = document.createElement("span");
      piece.className = "cer-confetti";
      var left = Math.random() * 100;
      var color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      var delay = (Math.random() * 2.2).toFixed(2);
      var dur = (3 + Math.random() * 2.5).toFixed(2);
      var size = (6 + Math.random() * 7).toFixed(1);
      var drift = (Math.random() * 120 - 60).toFixed(0);
      var spin = (Math.random() * 720 - 360).toFixed(0);
      piece.style.left = left + "%";
      piece.style.background = color;
      piece.style.width = size + "px";
      piece.style.height = (Number(size) * 1.6).toFixed(1) + "px";
      piece.style.animationDelay = delay + "s";
      piece.style.animationDuration = dur + "s";
      piece.style.setProperty("--cer-drift", drift + "px");
      piece.style.setProperty("--cer-spin", spin + "deg");
      if (i % 3 === 0) piece.style.borderRadius = "50%";
      layer.appendChild(piece);
    }
  }

  /* ---------------- overlay lifecycle ---------------- */

  function close() {
    if (!overlay) return;
    document.removeEventListener("keydown", onKey);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  /* The 📸 button hands a "champion" hype payload to ShareCard when it
     exists (it may be added later); otherwise the button is not rendered. */
  function shareChampion(payload) {
    try {
      if (window.ShareCard && typeof window.ShareCard.hype === "function") {
        window.ShareCard.hype(payload);
      }
    } catch (err) {
      if (window.console) console.error("Champion share failed:", err);
    }
  }

  function buildOverlay(data) {
    var esc = (data.ctx.helpers && data.ctx.helpers.esc) ||
      function (s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
      };

    overlay = document.createElement("div");
    overlay.className = "cer-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Champion crowned");

    var confettiLayer = document.createElement("div");
    confettiLayer.className = "cer-confetti-layer";
    confettiLayer.setAttribute("aria-hidden", "true");

    var card = document.createElement("div");
    card.className = "cer-card";

    var pointsLine = data.points != null
      ? '<div class="cer-points"><b>' + esc(fmtPoints(data.points)) + "</b> points</div>"
      : "";
    var teamLine = data.teamName
      ? '<div class="cer-team">Drafted by <strong>' + esc(data.teamName) + "</strong></div>"
      : "";
    var shareBtn = data.canShare
      ? '<button type="button" class="cer-btn cer-share">📸 Share the champion</button>'
      : "";

    card.innerHTML =
      '<div class="cer-kicker">WC26 Knockout · The Longest Yard</div>' +
      '<div class="cer-flag" aria-hidden="true">' + esc(data.flag) + "</div>" +
      '<div class="cer-country">' + esc(data.countryName) + "</div>" +
      '<div class="cer-title">CHAMPIONS</div>' +
      teamLine +
      pointsLine +
      '<div class="cer-actions">' +
        shareBtn +
        '<button type="button" class="cer-btn cer-close-btn">Close</button>' +
      "</div>" +
      '<button type="button" class="cer-x" aria-label="Close">✕</button>';

    overlay.appendChild(confettiLayer);
    overlay.appendChild(card);

    overlay.addEventListener("click", function (e) {
      var t = e.target;
      if (!t) return;
      if (t === overlay || (t.classList && (t.classList.contains("cer-close-btn") || t.classList.contains("cer-x")))) {
        close();
        return;
      }
      if (t.classList && t.classList.contains("cer-share")) {
        shareChampion(data.hype);
      }
    });

    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    spawnConfetti(confettiLayer);
  }

  /* ---------------- render hook ---------------- */

  function render(ctx) {
    if (!ctx || !ctx.standings || !ctx.bracket || !ctx.draft) return;

    var champId = championId(ctx);
    if (!champId) return; /* no champion yet */

    /* Already shown for this champion (this session OR a past load)? Skip. */
    if (shownChampionId === champId) return;
    if (readSeen() === String(champId)) {
      shownChampionId = champId;
      return;
    }

    var country = resolveCountry(ctx, champId);
    if (!country) return; /* can't celebrate an unknown country — bail quietly */

    var abbr = ownerAbbr(ctx, champId);
    var row = ownerRow(ctx, abbr);
    var team = (row && row.team) || (abbr ? { abbr: abbr, name: abbr } : null);

    var data = {
      ctx: ctx,
      championId: champId,
      flag: country.flag || "🏆",
      countryName: country.name || "",
      teamName: team ? team.name : null,
      points: row ? row.points : null,
      canShare: !!(window.ShareCard && typeof window.ShareCard.hype === "function"),
      hype: {
        kind: "champion",
        countryId: champId,
        teamAbbr: abbr || null,
        roundLabel: "Champion",
        points: row ? row.points : null,
        note: (team ? team.name + " — " : "") + (country.name || "") + " win it all"
      }
    };

    /* Persist + mark before painting so a re-render mid-show can't double-fire. */
    shownChampionId = champId;
    writeSeen(champId);

    try {
      close(); /* never stack two overlays */
      buildOverlay(data);
    } catch (err) {
      if (window.console) console.error("Ceremony render failed:", err);
    }
  }

  if (window.Hub && typeof window.Hub.onRender === "function") {
    window.Hub.onRender(render);
  }
})();
