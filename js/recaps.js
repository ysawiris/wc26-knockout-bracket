/* ============================================================
   AI match recaps. Loads data/recaps.json (a future knockout feed;
   absent in manual-entry v1, so this layer is dormant — fetch falls
   back to null and nothing renders) and opens a panel with the
   AI-written summary and the goal-by-goal scorer list for any
   FINISHED knockout match.

   Decoupled from the card renderer: it keys each recap to its
   match by the FIFA match id (fx.matchId, set in live.js). Flags
   reuse Live.resolveCountry, so country naming stays consistent
   with the rest of the hub.

   Knockout note: recap entries are tagged by round (R32/R16/QF/
   SF/Final) instead of group. The badge prefers r.round and is
   omitted entirely when no round is present, so group-stage
   leftovers (or knockout entries that have not been backfilled in
   data/recaps.json yet) never throw and never show "Group".
   enhance() is a no-op — the unified Match Center owns the per-
   card recap surface.
   ============================================================ */

var Recaps = (function () {
  "use strict";

  var byId = {};
  var loaded = false;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function flagFor(name) {
    try {
      var c = window.Live && Live.resolveCountry(name);
      return c ? c.flag : "";
    } catch (err) {
      return "";
    }
  }

  /* Prefer the hub's own country name (e.g. "South Korea") over the feed's
     ("Korea Republic") so recaps read consistently with the rest of the site. */
  function displayName(name) {
    try {
      var c = window.Live && Live.resolveCountry(name);
      return c ? c.name : name;
    } catch (err) {
      return name;
    }
  }

  /* Knockout round badge HTML for a recap entry. Knockout recaps carry a
     `round` field (R32/R16/QF/SF/Final); prefer it, fall back to the hub's
     roundLabel helper, and omit the badge entirely when neither is present
     (e.g. the data file still has only group-stage entries). Never shows the
     old "Group X" text and never throws on missing data. */
  function roundBadge(r) {
    if (!r) return "";
    var label = r.roundLabel || r.round;
    if (!label) return "";
    try {
      var helpers = window.Hub && Hub.ctx() && Hub.ctx().helpers;
      if (helpers && typeof helpers.roundLabel === "function") {
        label = helpers.roundLabel(r.round) || label;
      }
    } catch (err) {
      /* fall back to the raw round value */
    }
    return '<span class="rcp-grp">' + esc(label) + "</span>";
  }

  function load() {
    // Cache-bust like live.json — GitHub Pages serves these with max-age=600.
    return fetch("data/recaps.json?v=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (data) {
        byId = (data && data.byId) || {};
        loaded = true;
        // Inject into whatever the app has already rendered.
        if (window.Hub && Hub.ctx()) enhance(Hub.ctx());
        return byId;
      });
  }

  /* Registered with Hub.onRender(); fires after every full data render.

     DISABLED (intentional no-op): the per-card recap now opens inside the
     unified Match Center (js/matchcenter.js), which loads data/recaps.json
     itself and surfaces this same summary + goal list. Leaving this a no-op
     means each bracket card shows a single "📊 Match Center" button instead
     of a separate 📝 Recap. The guard below mirrors the frozen ctx contract
     (standings / bracket / draft) so that, even if the injector is ever re-
     enabled, the module can never throw on the knockout ctx. */
  function enhance(ctx) {
    return;
    /* eslint-disable no-unreachable */
    if (!ctx || !ctx.standings || !ctx.bracket || !ctx.draft) return;
    if (!loaded || !ctx.allFixtures) return;
    ctx.allFixtures.forEach(function (fx) {
      if (!fx.matchId || !byId[fx.matchId]) return;
      if (!(window.Live && Live.FINISHED[fx.status])) return;

      var card = document.getElementById("sched-" + fx.id);
      if (!card) return;
      // The card foot now wraps its buttons in .m-actions; fall back to the
      // foot itself for older markup.
      var actions = card.querySelector(".m-actions") || card.querySelector(".m-foot");
      if (!actions || actions.querySelector(".recap-act")) return;

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "m-act recap-act";
      btn.innerHTML = "📝 Recap";
      btn.setAttribute("aria-haspopup", "dialog");
      btn.addEventListener("click", function () { open(fx.matchId); });

      // Sit just before the ▶ Highlights link when present.
      var hl = actions.querySelector("a.m-act");
      actions.insertBefore(btn, hl || null);
    });
  }

  /* ---------------- modal ---------------- */

  var overlay = null;

  function close() {
    if (!overlay) return;
    document.removeEventListener("keydown", onKey);
    overlay.parentNode && overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function goalRow(g) {
    var icon = g.ownGoal ? "🥅" : "⚽";
    var tags = "";
    if (g.ownGoal) tags += '<span class="rcp-tag og">o.g.</span>';
    if (g.penalty) tags += '<span class="rcp-tag pen">pen</span>';
    return (
      '<li class="rcp-goal ' + (g.side === "home" ? "home" : "away") + '">' +
        '<span class="rcp-min">' + esc(g.minute) + "</span>" +
        '<span class="rcp-ico">' + icon + "</span>" +
        '<span class="rcp-player">' + esc(g.player) + tags + "</span>" +
        '<span class="rcp-team">' + flagFor(g.team) + " " + esc(displayName(g.team)) + "</span>" +
      "</li>"
    );
  }

  function open(matchId) {
    var r = byId[matchId];
    if (!r) return;
    close();

    var goals = (r.goals || []).map(goalRow).join("");
    var goalsBlock = goals
      ? '<ul class="rcp-goals">' + goals + "</ul>"
      : '<p class="rcp-nogoals">No goals — it finished ' + r.homeGoals + "–" + r.awayGoals + ".</p>";

    var homeName = displayName(r.home);
    var awayName = displayName(r.away);
    var ytq = encodeURIComponent(homeName + " vs " + awayName + " World Cup 2026 highlights");
    var badge = r.ai
      ? '<span class="rcp-badge ai">✨ AI recap</span>'
      : '<span class="rcp-badge">📝 Recap</span>';

    overlay = document.createElement("div");
    overlay.className = "rcp-overlay";
    overlay.innerHTML =
      '<div class="rcp-modal" role="dialog" aria-modal="true" aria-label="Match recap">' +
        '<button class="rcp-close" aria-label="Close">✕</button>' +
        '<div class="rcp-head">' +
          '<div class="rcp-meta">' + badge + roundBadge(r) + "</div>" +
          '<div class="rcp-score">' +
            '<span class="rcp-side">' + flagFor(r.home) + " " + esc(homeName) + "</span>" +
            '<span class="rcp-nums">' + r.homeGoals + '<span>–</span>' + r.awayGoals + "</span>" +
            '<span class="rcp-side away">' + esc(awayName) + " " + flagFor(r.away) + "</span>" +
          "</div>" +
          (r.venue ? '<p class="rcp-venue">' + esc(r.venue) + "</p>" : "") +
        "</div>" +
        '<p class="rcp-summary">' + esc(r.summary) + "</p>" +
        goalsBlock +
        '<div class="rcp-foot">' +
          '<a class="rcp-yt" target="_blank" rel="noopener" href="https://www.youtube.com/results?search_query=' +
            ytq + '">▶ Watch highlights</a>' +
          '<span class="rcp-auto">Auto-generated from the live feed</span>' +
        "</div>" +
      "</div>";

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || e.target.classList.contains("rcp-close")) close();
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
  }

  /* ---------------- boot ---------------- */

  if (window.Hub) Hub.onRender(enhance);
  load();

  // enhance is exposed so the app can re-inject after a filter re-render
  // rebuilds the schedule DOM (Hub.onRender only fires on full data renders).
  return { load: load, open: open, enhance: enhance };
})();
