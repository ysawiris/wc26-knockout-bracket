/*
  sw.js — service worker for the WC26 Draft Hub PWA.

  Lives at the repo ROOT so its default scope covers the whole GitHub Pages
  subpath (https://ysawiris.github.io/wc26-draft-tracker/). Every cached URL is
  resolved RELATIVE to self.registration.scope — never hardcode "/" paths,
  because the site is NOT served from the domain root.

  Strategy:
  - Precache the app shell (html, css, js, manifest, icon) on install, with
    cache:"no-cache" requests so GitHub Pages' 10-minute HTTP cache can never
    seed a fresh version's cache with pre-deploy bodies.
  - Navigations and everything under data/ (live.json, odds.json): NETWORK-
    FIRST, cache fallback — deploys, fresh scores and fresh betting lines
    always win while online, offline still renders.
  - Every other same-origin GET: STALE-WHILE-REVALIDATE — answered from cache
    instantly, refreshed from the network in the background, so even a deploy
    that forgets the VERSION bump self-heals on the member's next visit.
  - Cross-origin requests (FIFA API, Google Fonts, ...) pass through untouched.
  - Updates apply automatically: skipWaiting() on install + clients.claim() on
    activate, and sw-register.js reloads the page once on controllerchange, so a
    deploy lands on its own — no "tap to refresh".

  >>> Bump VERSION on deploys that change js/, css/, index.html, or the
  >>> manifest. Stale-while-revalidate self-heals a forgotten bump on the
  >>> next visit, but the bump makes updates land immediately and lets
  >>> activate() drop the old cache.
*/

(function () {
  "use strict";

  var VERSION = "lyko-v24";
  var CACHE_NAME = "wc26-cache-" + VERSION;
  var CACHE_PREFIX = "wc26-cache-";
  var DATA_DIR_RE = /\/data\/[^/]+\.json$/;

  /* Explicit precache list — every shell file in the repo, listed by hand
     (no runtime globbing). data/*.json is deliberately ABSENT: live scores
     and betting lines must never be served cache-first. Missing files are
     skipped, not fatal. */
  var PRECACHE_PATHS = [
    "./",
    "index.html",
    "manifest.webmanifest",
    "assets/icon.svg",
    "css/styles.css",
    "css/board-extras.css",
    "css/stats.css",
    "css/extras.css",
    "css/my-team.css",
    "css/odds.css",
    "css/race.css",
    "css/alerts.css",
    "css/share-card.css",
    "css/road.css",
    "css/recaps.css",
    "css/matchcenter.css",
    "css/ceremony.css",
    "js/data.js",
    "js/store.js",
    "js/my-team.js",
    "js/schedule.js",
    "js/live.js",
    "js/app.js",
    "js/board-extras.js",
    "js/stats.js",
    "js/refresh.js",
    "js/live-direct.js",
    "js/odds.js",
    "js/road.js",
    "js/race.js",
    "js/alerts.js",
    "js/share-card.js",
    "js/recaps.js",
    "js/xg.js",
    "js/matchcenter.js",
    "js/ceremony.js",
    "js/sw-register.js"
  ];

  /* ---------------- url helpers ---------------- */

  function scopeUrl(path) {
    /* Resolve a repo-relative path against the registration scope so the
       cache keys match what the page actually requests on GitHub Pages. */
    return new URL(path, self.registration.scope).toString();
  }

  function canonicalUrl(url) {
    /* Strip the query string (the app cache-busts live.json with ?v=...)
       so one cache entry serves every busted variant. */
    return url.origin + url.pathname;
  }

  function offlineResponse() {
    return new Response("", { status: 503, statusText: "offline" });
  }

  /* ---------------- cache write (quota-safe) ---------------- */

  function putSafe(cacheKey, response) {
    /* Quota or opaque-response errors must never break the fetch we are
       answering — caching is strictly best-effort. */
    return caches.open(CACHE_NAME).then(function (cache) {
      return cache.put(cacheKey, response);
    }).catch(function (err) {
      console.error("SW cache.put skipped:", cacheKey, err);
    });
  }

  /* ---------------- install: precache + skipWaiting ---------------- */

  self.addEventListener("install", function (event) {
    /* Activate this version as soon as it finishes installing — no waiting for
       all tabs to close. Paired with clients.claim() + the page's reload-on-
       controllerchange, a deploy applies automatically (no "tap to refresh"). */
    self.skipWaiting();
    event.waitUntil(
      caches.open(CACHE_NAME).then(function (cache) {
        return Promise.all(PRECACHE_PATHS.map(function (path) {
          /* Per-file add so one missing/renamed file cannot brick install.
             cache:"no-cache" revalidates against the origin's ETags so the
             browser's 10-min GitHub Pages HTTP cache can't pin stale bodies
             into a brand-new cache version. */
          var req = new Request(scopeUrl(path), { cache: "no-cache" });
          return cache.add(req).catch(function (err) {
            console.error("SW precache skipped:", path, err);
          });
        }));
      })
    );
  });

  /* Legacy fallback: honor a SKIP_WAITING message if any client still posts one.
     skipWaiting() already runs on install, so this is normally a no-op. */
  self.addEventListener("message", function (event) {
    if (event.data && event.data.type === "SKIP_WAITING") {
      self.skipWaiting();
    }
  });

  /* ---------------- activate: drop old versions + claim ---------------- */

  self.addEventListener("activate", function (event) {
    event.waitUntil(
      caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (key) {
          if (key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return Promise.resolve(false);
        }));
      }).then(function () {
        return self.clients.claim();
      })
    );
  });

  /* ---------------- fetch strategies ---------------- */

  function handleNavigate(request, url) {
    /* Network-first so a fresh deploy always wins; cached shell offline. */
    return fetch(request).then(function (res) {
      if (res && res.ok) {
        putSafe(canonicalUrl(url), res.clone());
      }
      return res;
    }).catch(function () {
      return caches.match(request, { ignoreSearch: true }).then(function (hit) {
        return hit || caches.match(scopeUrl("index.html"));
      }).then(function (hit) {
        return hit || caches.match(scopeUrl("./"));
      }).then(function (hit) {
        return hit || offlineResponse();
      });
    });
  }

  function handleDataJson(request, url) {
    /* Network-first; cache under the query-less URL so the app's
       ?v=Date.now() cache-buster still hits the stored copy offline. */
    var key = canonicalUrl(url);
    return fetch(request).then(function (res) {
      if (res && res.ok) {
        putSafe(key, res.clone());
      }
      return res;
    }).catch(function () {
      return caches.match(key).then(function (hit) {
        return hit || offlineResponse();
      });
    });
  }

  function handleAsset(request, event) {
    /* Stale-while-revalidate: answer from cache instantly, refresh the cached
       copy in the background. A deploy that forgot the VERSION bump is then
       stale for at most one visit instead of forever. */
    return caches.match(request).then(function (hit) {
      var revalidate = fetch(request).then(function (res) {
        if (res && res.ok) {
          putSafe(request, res.clone());
        }
        return res;
      });
      if (hit) {
        /* Keep the worker alive long enough for the background refresh. */
        event.waitUntil(revalidate.catch(function () {}));
        return hit;
      }
      return revalidate;
    }).catch(function () {
      return offlineResponse();
    });
  }

  self.addEventListener("fetch", function (event) {
    var request = event.request;
    if (request.method !== "GET") return;

    var url;
    try {
      url = new URL(request.url);
    } catch (err) {
      return;
    }

    /* Cross-origin (FIFA API, fonts.googleapis.com, ...) passes through —
       no respondWith, the browser handles it natively. */
    if (url.origin !== self.location.origin) return;

    if (request.mode === "navigate") {
      event.respondWith(handleNavigate(request, url));
      return;
    }
    if (DATA_DIR_RE.test(url.pathname)) {
      event.respondWith(handleDataJson(request, url));
      return;
    }
    event.respondWith(handleAsset(request, event));
  });
})();
