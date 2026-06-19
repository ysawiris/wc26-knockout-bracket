/* Board extras — decorates the Standings tab with a copy/share toolbar,
   rank-movement arrows (persisted in localStorage), a per-team knockout
   progress line, and small flourishes for the leader and last pick. Pure
   decoration: reads ctx from Hub after every render, never mutates league
   data. Knockout model — no groups; progress tracks bracket advancement. */

(function () {
  "use strict";

  var SITE_URL = "https://ysawiris.github.io/wc26-knockout-bracket/";
  var STORE_KEY = "wc26ko.rankSnapshots";
  var COPY_RESTORE_MS = 1600;

  /* Official WhatsApp glyph (Simple Icons path) — inlined so the desktop
     share button is instantly recognizable without a network request. */
  var WHATSAPP_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.945c0 2.096.547 4.142 1.588 5.945L0 24l6.335-1.652a11.96 11.96 0 005.71 1.454h.005c6.581 0 11.945-5.359 11.945-11.945a11.86 11.86 0 00-3.495-8.408z"/>' +
    '</svg>';

  /* ---------------- rank snapshots (localStorage, fail-soft) ---------------- */

  function readSnapshots() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.current) return null;
      return { current: parsed.current, previous: parsed.previous || null };
    } catch (err) {
      return null;
    }
  }

  function writeSnapshots(snap) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(snap));
    } catch (err) {
      /* Private mode / quota exceeded — movement arrows just stay off. */
    }
  }

  function ranksFromStandings(standings) {
    var ranks = {};
    standings.forEach(function (row) { ranks[row.team.abbr] = row.rank; });
    return ranks;
  }

  function sameRanks(a, b) {
    if (!a || !b) return false;
    var ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every(function (k) { return a[k] === b[k]; });
  }

  /* Rotate stored current→previous when the order changes.
     Returns the rank map to diff against (or null if none yet). */
  function updateSnapshots(standings) {
    var current = ranksFromStandings(standings);
    var stored = readSnapshots();
    if (!stored) {
      writeSnapshots({ current: current, previous: null });
      return null;
    }
    if (!sameRanks(stored.current, current)) {
      writeSnapshots({ current: current, previous: stored.current });
      return stored.current;
    }
    return stored.previous;
  }

  /* ---------------- knockout helpers ---------------- */

  /* Round-key (R32/R16/QF/SF/Final/Champion/—) → readable label via the
     frozen helper, with graceful fallbacks for the sentinel values. */
  function reachedLabel(ctx, reached) {
    if (!reached || reached === "—") return null;
    if (reached === "Champion") return "Champion";
    var h = ctx.helpers;
    return (h && h.roundLabel) ? h.roundLabel(reached) : reached;
  }

  /* Flag glyphs for a team's drafted countries, resolved through
     draft.countriesByTeam → field.byId. Empty array pre-draft. */
  function draftedFlags(ctx, abbr) {
    var ids = (ctx.draft && ctx.draft.countriesByTeam && ctx.draft.countriesByTeam[abbr]) || [];
    var byId = (ctx.field && ctx.field.byId) || {};
    var flags = [];
    ids.forEach(function (id) {
      var c = byId[id];
      if (c && c.flag) flags.push(c.flag);
    });
    return flags;
  }

  function plural(n, one, many) {
    return n === 1 ? one : many;
  }

  /* ---------------- copy / share ---------------- */

  function buildOrderText(ctx) {
    var title = ctx.started ? "Knockout Standings" : "Provisional Draft Order";
    var stamp = (ctx.league && ctx.league.lastUpdated) || "live";
    var lines = ["🏆 WC26 " + title + " — " + stamp];

    ctx.standings.forEach(function (row) {
      var abbr = row.team.abbr;
      var flags = draftedFlags(ctx, abbr).join("");
      var line = row.rank + ". " + row.team.name;
      if (flags) line += " " + flags;

      if (ctx.started) {
        var pts = (typeof row.points === "number") ? Math.round(row.points * 10) / 10 : 0;
        line += " — " + pts + " " + plural(pts, "pt", "pts");
        var alive = row.aliveCount || 0;
        line += " · " + alive + " " + plural(alive, "country", "countries") + " alive";
        if (row.reached === "Champion") line += " · 🏆 Champion";
      } else {
        line += " — awaiting draft";
      }
      lines.push(line);
    });

    lines.push(ctx.started
      ? "Scoring: advancement (R32 3 · R16 5 · QF 8 · SF 13 · Final 21) + 0.1 / goal"
      : "Most advancement points from your 2 countries wins.");
    lines.push(SITE_URL);
    return lines.join("\n");
  }

  /* Short, preview-friendly WhatsApp message: one punchy hook line + the
     link (WhatsApp renders the OG card from the URL). Kept deliberately
     brief so it's easy to forward — the full standings live behind Copy. */
  function buildWhatsAppMessage(ctx) {
    var hook;
    if (ctx.started && ctx.standings && ctx.standings.length) {
      var leader = ctx.standings[0];
      var champ = ctx.standings.filter(function (r) { return r.reached === "Champion"; })[0];
      if (champ) {
        hook = "🏆 WC26 Knockout Hub — " + champ.team.name +
          " takes the crown with the title-winning country!";
      } else {
        var pts = (typeof leader.points === "number") ? Math.round(leader.points * 10) / 10 : 0;
        hook = "🏆 WC26 Knockout Hub — " + leader.team.name +
          " leads with " + pts + " advancement " + plural(pts, "point", "points") + "!";
      }
    } else {
      hook = "🏆 WC26 Knockout Hub — draft your 2 World Cup countries; " +
        "the deepest bracket run wins.";
    }
    return hook + "\nLive standings, bracket & scores 👇\n" + SITE_URL;
  }

  function openWhatsApp(ctx) {
    var url = "https://wa.me/?text=" +
      encodeURIComponent(buildWhatsAppMessage(ctx));
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function copyTextFallback(text) {
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

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return copyTextFallback(text);
      });
    }
    return copyTextFallback(text);
  }

  function flashCopied(btn) {
    if (btn.getAttribute("data-bx-flashing")) return;
    btn.setAttribute("data-bx-flashing", "1");
    var original = btn.textContent;
    btn.textContent = "Copied ✓";
    btn.classList.add("is-copied");
    window.setTimeout(function () {
      btn.textContent = original;
      btn.classList.remove("is-copied");
      btn.removeAttribute("data-bx-flashing");
    }, COPY_RESTORE_MS);
  }

  function onToolbarClick(e) {
    var btn = e.target.closest("[data-bx-action]");
    if (!btn || !window.Hub) return;
    var ctx = window.Hub.ctx();
    if (!ctx) return;

    if (btn.getAttribute("data-bx-action") === "whatsapp") {
      openWhatsApp(ctx);
      return;
    }

    var text = buildOrderText(ctx);

    if (btn.getAttribute("data-bx-action") === "copy") {
      copyText(text).then(function () { flashCopied(btn); }).catch(function () {});
      return;
    }
    if (btn.getAttribute("data-bx-action") === "share" && navigator.share) {
      var title = "WC26 " + (ctx.started ? "Knockout Standings" : "Provisional Draft Order");
      try {
        navigator.share({ title: title, text: text }).catch(function () {});
      } catch (err) {
        /* User cancelled or payload unsupported — nothing to do. */
      }
    }
  }

  /* ---------------- toolbar (inserted once, guarded by id) ---------------- */

  /* Touch-primary devices (phones/tablets) get the native share sheet, which
     already lists WhatsApp beside AirDrop/iMessage. Desktops — where that
     sheet is absent or WhatsApp-less — get a dedicated WhatsApp button
     instead. Mutually exclusive, so neither device shows two WhatsApp paths. */
  function isTouchPrimary() {
    if (!navigator.share) return false;
    var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    return (navigator.maxTouchPoints || 0) > 0 || !!coarse;
  }

  function ensureToolbar() {
    if (document.getElementById("bx-toolbar")) return;
    var hint = document.getElementById("board-hint");
    var list = document.getElementById("board-list");
    if (!hint || !list || !hint.parentNode) return;

    var bar = document.createElement("div");
    bar.id = "bx-toolbar";
    bar.className = "bx-toolbar";
    var html =
      '<button type="button" class="bx-btn" data-bx-action="copy" ' +
        'aria-label="Copy the current standings to your clipboard">📋 Copy standings</button>';
    if (isTouchPrimary()) {
      html +=
        '<button type="button" class="bx-btn" data-bx-action="share" ' +
          'aria-label="Share the current standings">📤 Share</button>';
    } else {
      html +=
        '<button type="button" class="bx-btn bx-whatsapp" data-bx-action="whatsapp" ' +
          'aria-label="Share the knockout hub on WhatsApp">' +
          WHATSAPP_SVG + '<span>Share on WhatsApp</span></button>';
    }
    bar.innerHTML = html;
    bar.addEventListener("click", onToolbarClick);
    hint.parentNode.insertBefore(bar, list);
  }

  /* ---------------- per-row decoration ---------------- */

  function cleanRow(li) {
    Array.prototype.forEach.call(
      li.querySelectorAll(".bx-move, .bx-extras, .bx-crown, .bx-lastpick, .bx-champion"),
      function (n) { n.parentNode.removeChild(n); }
    );
  }

  function injectMovement(ctx, li, row, prevRanks) {
    if (!ctx.started || !prevRanks) return;
    var prev = prevRanks[row.team.abbr];
    if (typeof prev !== "number") return;
    var top = li.querySelector(".team-top");
    if (!top) return;

    var delta = prev - row.rank;
    var badge = document.createElement("span");
    if (delta > 0) {
      badge.className = "bx-move bx-up";
      badge.textContent = "▲" + delta;
      badge.title = "Up " + delta + (delta === 1 ? " place" : " places") + " since the order last changed";
    } else if (delta < 0) {
      badge.className = "bx-move bx-down";
      badge.textContent = "▼" + (-delta);
      badge.title = "Down " + (-delta) + (delta === -1 ? " place" : " places") + " since the order last changed";
    } else {
      badge.className = "bx-move bx-flat";
      badge.textContent = "·";
      badge.title = "No movement since the order last changed";
    }
    badge.setAttribute("aria-label", badge.title);
    top.appendChild(badge);
  }

  /* Pre-draft: "▸ Awaiting draft". Drafted but bracket not yet underway:
     "▸ Round of 32 awaits". Underway: "▸ Alive in QF · 2 countries" if any
     country is still in, otherwise "▸ Eliminated in R16". Champion gets its
     own celebratory line. Returns the injected node so the last-pick pill
     can ride on it. */
  function injectExtras(ctx, li, row) {
    var teamCell = li.querySelector(".team");
    if (!teamCell) return null;
    var h = ctx.helpers;

    var line;
    if (!ctx.started) {
      var complete = ctx.draft && ctx.draft.complete;
      line = complete ? "▸ Round of 32 awaits" : "▸ Awaiting draft";
    } else {
      var alive = row.aliveCount || 0;
      var label = reachedLabel(ctx, row.reached);
      if (row.reached === "Champion") {
        line = "▸ World Cup champion 🏆";
      } else if (alive > 0) {
        line = "▸ Alive in " + (label || "the bracket") +
          " · " + alive + " " + plural(alive, "country", "countries");
      } else if (label) {
        line = "▸ Eliminated in " + label;
      } else {
        line = "▸ Yet to play";
      }
    }

    var extras = h.el("div", "bx-extras", h.esc(line));
    teamCell.appendChild(extras);
    return extras;
  }

  function injectFlourishes(ctx, li, row, extras) {
    if (!ctx.started) return;

    /* Champion badge supersedes the leader crown when a team's country has
       won the whole thing; otherwise the rank-1 team gets the crown. */
    var name = li.querySelector(".team-name");
    if (row.reached === "Champion" && name && name.insertAdjacentElement) {
      var trophy = document.createElement("span");
      trophy.className = "bx-champion";
      trophy.textContent = "🏆";
      trophy.title = "Drafted the World Cup champion";
      trophy.setAttribute("aria-label", trophy.title);
      name.insertAdjacentElement("afterend", trophy);
    } else if (row.rank === 1 && name && name.insertAdjacentElement) {
      var crown = document.createElement("span");
      crown.className = "bx-crown";
      crown.textContent = "👑";
      crown.title = "Leading the knockout standings";
      crown.setAttribute("aria-label", crown.title);
      name.insertAdjacentElement("afterend", crown);
    }

    if (row.rank === ctx.standings.length && extras) {
      var pill = document.createElement("span");
      pill.className = "bx-lastpick";
      pill.textContent = "last place 😬";
      pill.title = "Currently bottom of the standings";
      extras.appendChild(pill);
    }
  }

  function decorateRows(ctx, prevRanks) {
    var list = document.getElementById("board-list");
    if (!list) return;
    var byAbbr = {};
    ctx.standings.forEach(function (row) { byAbbr[row.team.abbr] = row; });

    Array.prototype.forEach.call(list.querySelectorAll("li.row[data-abbr]"), function (li) {
      var row = byAbbr[li.dataset.abbr];
      if (!row) return;
      cleanRow(li);
      injectMovement(ctx, li, row, prevRanks);
      var extras = injectExtras(ctx, li, row);
      injectFlourishes(ctx, li, row, extras);
    });
  }

  /* ---------------- entry point ---------------- */

  function render(ctx) {
    if (!ctx || !ctx.standings || !ctx.bracket || !ctx.draft) return;
    if (!ctx.standings.length) return;
    ensureToolbar();
    var prevRanks = updateSnapshots(ctx.standings);
    decorateRows(ctx, prevRanks);
  }

  if (window.Hub && typeof window.Hub.onRender === "function") {
    window.Hub.onRender(render);
  }
})();
