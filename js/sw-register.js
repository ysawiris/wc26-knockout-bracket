/*
  sw-register.js — registers the root-level service worker (sw.js) and applies
  updates AUTOMATICALLY (no "tap to refresh" pill).

  The site lives on a GitHub Pages SUBPATH, so the worker is registered with the
  RELATIVE path "sw.js" (resolves against the page URL) and the default scope —
  never a leading-slash path.

  Auto-update flow: sw.js calls self.skipWaiting() on install, so a freshly
  deployed worker activates the moment it finishes installing; its
  clients.claim() (sw.js activate) fires a "controllerchange", and we reload the
  page exactly once — guarded against loops and against the first-ever install.
  register() uses updateViaCache:"none" so the browser always re-checks sw.js
  from the network (not the host's 10-min HTTP cache), and we call reg.update()
  on load and whenever the tab regains focus so an already-open hub picks up a
  deploy on its own, no manual refresh.
*/

(function () {
  "use strict";

  if (!("serviceWorker" in navigator)) return;

  /* Dev mode: on localhost the service worker only causes stale-asset pain (it
     serves cached JS/CSS over fresh edits). Unregister any existing worker,
     drop its caches, and DON'T register — the PWA still works on the real
     domain. */
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

  /* True when a worker already controlled the page at script start — so any
     later controllerchange is an UPDATE (reload), not the first install. */
  var hadController = !!navigator.serviceWorker.controller;
  var reloaded = false;

  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!hadController) { hadController = true; return; } // first install — no reload
    if (reloaded) return;                                 // reload exactly once per update
    reloaded = true;
    window.location.reload();
  });

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(function (reg) {
      /* Check for a new worker now, and again whenever the tab becomes visible
         or regains focus, so a deploy reaches an open hub within moments. */
      reg.update();
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") reg.update();
      });
      window.addEventListener("focus", function () { reg.update(); });
    }).catch(function (err) {
      console.error("Service worker registration failed:", err);
    });
  });
})();
