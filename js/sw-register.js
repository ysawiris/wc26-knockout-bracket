/*
  sw-register.js — registers the root-level service worker (sw.js) and runs a
  lightweight update flow. The site lives on a GitHub Pages SUBPATH, so the
  worker is registered with the RELATIVE path "sw.js" (resolves against the
  page URL) and the default scope — never a leading-slash path.

  Update flow: when a new worker reaches "installed" while an old one still
  controls the page, it WAITS (sw.js does not skipWaiting on install) and a
  small fixed "tap to refresh" pill appears. Tapping posts SKIP_WAITING to the
  waiting worker; its activation fires controllerchange, which reloads the
  page exactly once (guarded against loops and against the very first
  install, which should not reload). Styles are injected via a <style> tag —
  no separate css file for this module.
*/

(function () {
  "use strict";

  var PILL_ID = "swr-update-pill";
  var STYLE_ID = "swr-style";

  if (!("serviceWorker" in navigator)) return;

  /* Dev mode: on localhost the service worker only causes stale-asset pain
     (it serves cached JS/CSS over fresh edits). Unregister any existing
     worker, drop its caches, and DON'T register — the PWA still works on the
     real domain. */
  var host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "" || host === "0.0.0.0") {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) { r.unregister(); });
    });
    if (window.caches && caches.keys) {
      caches.keys().then(function (keys) { keys.forEach(function (k) { caches.delete(k); }); });
    }
    return;
  }

  /* True when a worker already controlled the page at script start — i.e.
     any later controllerchange is an UPDATE, not the first install. */
  var hadController = !!navigator.serviceWorker.controller;
  var reloaded = false;
  var registration = null;

  /* ---------------- update pill ---------------- */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "#" + PILL_ID + "{" +
        "position:fixed;left:50%;transform:translateX(-50%);" +
        "bottom:calc(78px + env(safe-area-inset-bottom,0px));z-index:240;" +
        "border:0;border-radius:999px;padding:10px 18px;" +
        "font:700 .78rem/1 'Archivo',sans-serif;letter-spacing:.04em;" +
        "color:#1a1206;cursor:pointer;white-space:nowrap;" +
        "background:var(--gold-grad,linear-gradient(180deg,#fdf3cf 0%,#f3d98a 34%,#c89638 66%,#f7e3a6 100%));" +
        "box-shadow:0 6px 26px rgba(0,0,0,.55);" +
      "}" +
      "#" + PILL_ID + ":hover{transform:translateX(-50%) translateY(-1px);}" +
      "#" + PILL_ID + ":focus-visible{outline:2px solid var(--gold-2,#efd185);outline-offset:2px;}" +
      "@media (min-width:701px){#" + PILL_ID + "{bottom:24px;}}";
    document.head.appendChild(style);
  }

  function showUpdatePill() {
    if (document.getElementById(PILL_ID)) return;
    if (!document.body) return;
    injectStyles();
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = PILL_ID;
    btn.setAttribute("aria-label", "A new version is available. Tap to refresh.");
    btn.textContent = "↻ New version — tap to refresh";
    btn.addEventListener("click", function () {
      btn.disabled = true;
      btn.textContent = "↻ Updating…";
      var waiting = registration && registration.waiting;
      if (waiting) {
        /* Activate the waiting worker; controllerchange then reloads once. */
        waiting.postMessage({ type: "SKIP_WAITING" });
      } else {
        reloaded = true; // nothing waiting (edge case) — plain reload
        window.location.reload();
      }
    });
    document.body.appendChild(btn);
  }

  /* ---------------- update detection ---------------- */

  function watchInstalling(reg) {
    var worker = reg.installing;
    if (!worker) return;
    worker.addEventListener("statechange", function () {
      /* "installed" with an existing controller = a NEW version is ready
         (on first-ever install there is no controller — no pill then). */
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        showUpdatePill();
      }
    });
  }

  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!hadController) {
      /* First install just claimed the page (clients.claim) — no reload. */
      hadController = true;
      return;
    }
    if (reloaded) return; // loop guard: reload exactly once per update
    reloaded = true;
    window.location.reload();
  });

  /* ---------------- registration ---------------- */

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      registration = reg;
      /* A worker may already be waiting (page sat open across a deploy). */
      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdatePill();
      }
      watchInstalling(reg);
      reg.addEventListener("updatefound", function () {
        watchInstalling(reg);
      });
    }).catch(function (err) {
      console.error("Service worker registration failed:", err);
    });
  });
})();
