/* Share card — adds a "📸 Share card" button beside the board-extras
   copy/share toolbar. On tap it paints the current knockout standings
   onto a 1080x1350 canvas (gold-on-black, branded like the site),
   exports a PNG, and hands it to the native share sheet — or downloads
   the file when Web Share with files isn't available. Pure read-only:
   pulls the latest ctx from Hub at click time, never mutates league
   data. Each row shows the team's 2 drafted country flags, its total
   knockout points, and how far its run has gone. */

(function () {
  "use strict";

  var SITE_LABEL = "ysawiris.github.io/wc26-knockout-bracket";
  var FILE_NAME = "wc26-knockout-standings.png";
  var DEFAULT_LABEL = "📸 Share card";
  var BUSY_LABEL = "📸 …";
  var ERROR_LABEL = "Couldn't share";
  var ERROR_RESTORE_MS = 2200;
  var REVOKE_DELAY_MS = 4000;

  /* Canvas geometry — exact 1080x1350 export, no DPR scaling. */
  var CARD_W = 1080;
  var CARD_H = 1350;
  var MARGIN = 72;
  var RIGHT_X = CARD_W - MARGIN;
  var ROWS_TOP = 392;
  var ROW_H = 70;
  var NAME_X = 170;
  var CHIP_X = 700;
  var CHIP_W = 130;

  /* Webfonts are unreliable in canvas — bold serif + system sans stacks. */
  var SERIF = "Georgia, 'Times New Roman', serif";
  var SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

  /* Palette mirrored from css/styles.css :root tokens. */
  var GOLD_1 = "#fdf3cf";
  var GOLD_2 = "#efd185";
  var GOLD_3 = "#c89638";
  var TEXT = "#f4ede0";
  var DIM = "#b6a786";
  var FAINT = "#8a7c60";

  /* UI state lives in module scope so it survives the ~2 min re-renders
     (the toolbar itself persists — app.js only rewrites #board-list). */
  var generating = false;
  var restoreTimer = null;

  /* ---------------- button mounting ---------------- */

  function fallbackToolbar() {
    var existing = document.getElementById("sc-toolbar");
    if (existing) return existing;
    var list = document.getElementById("board-list");
    if (!list || !list.parentNode) return null;
    var bar = document.createElement("div");
    bar.id = "sc-toolbar";
    bar.className = "sc-toolbar";
    list.parentNode.insertBefore(bar, list);
    return bar;
  }

  function removeFallbackIfEmpty() {
    var fb = document.getElementById("sc-toolbar");
    if (fb && !fb.childNodes.length && fb.parentNode) fb.parentNode.removeChild(fb);
  }

  function ensureButton() {
    var bx = document.getElementById("bx-toolbar");
    var btn = document.getElementById("sc-share");
    if (btn) {
      /* board-extras' toolbar can appear after our fallback did — migrate. */
      if (bx && btn.parentNode !== bx) {
        bx.appendChild(btn);
        removeFallbackIfEmpty();
      }
      return;
    }
    var bar = bx || fallbackToolbar();
    if (!bar) return;
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "sc-share";
    btn.className = "bx-btn sc-btn";
    btn.setAttribute("data-sc-action", "card");
    btn.setAttribute("aria-label", "Share a picture of the knockout standings");
    btn.textContent = DEFAULT_LABEL;
    bar.appendChild(btn);
  }

  /* ---------------- button states ---------------- */

  function setBusy(btn) {
    btn.classList.add("is-busy");
    btn.classList.remove("is-error");
    btn.setAttribute("aria-busy", "true");
    btn.textContent = BUSY_LABEL;
  }

  function setIdle(btn) {
    btn.classList.remove("is-busy", "is-error");
    btn.removeAttribute("aria-busy");
    btn.textContent = DEFAULT_LABEL;
  }

  function finishOk(btn) {
    generating = false;
    setIdle(btn);
  }

  function finishError(btn) {
    generating = false;
    btn.classList.remove("is-busy");
    btn.removeAttribute("aria-busy");
    btn.classList.add("is-error");
    btn.textContent = ERROR_LABEL;
    if (restoreTimer) window.clearTimeout(restoreTimer);
    restoreTimer = window.setTimeout(function () { setIdle(btn); }, ERROR_RESTORE_MS);
  }

  /* ---------------- card data helpers ---------------- */

  function safeAccent(accent) {
    if (typeof accent === "string" && /^#[0-9a-fA-F]{3,8}$/.test(accent)) return accent;
    return GOLD_3;
  }

  function managerLine(team) {
    var managers = team.managers;
    if (!managers || !managers.length) return "";
    return managers.map(function (full) {
      var parts = String(full).trim().split(/\s+/);
      return parts[parts.length - 1] || "";
    }).join(" · ");
  }

  /* Walk the bracket and find the deepest round that has any decided
     match — that's how far the tournament has progressed. */
  function bracketProgress(hub) {
    var rounds = (hub.bracket && hub.bracket.rounds) || [];
    var deepest = null;
    var champion = false;
    rounds.forEach(function (rnd) {
      var matches = rnd.matches || [];
      var anyWinner = matches.some(function (m) { return m && m.winnerId; });
      if (!anyWinner) return;
      deepest = rnd;
      if (rnd.name === "Final") {
        var done = matches.every(function (m) { return m && m.winnerId; });
        if (done) champion = true;
      }
    });
    return { round: deepest, champion: champion };
  }

  function subtitleText(hub) {
    if (!hub.draft || !hub.draft.complete) {
      return "Draft order — picks lock the seeding";
    }
    if (!hub.started) return "Provisional — first R32 winners set the order";
    var stamp = "";
    try {
      stamp = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (err) {
      stamp = (hub.league && hub.league.lastUpdated) || "";
    }
    var prog = bracketProgress(hub);
    var phase;
    if (prog.champion) phase = "Champion crowned";
    else if (prog.round) phase = "Through the " + (prog.round.label || prog.round.name);
    else phase = "Bracket underway";
    return (stamp ? stamp + "  ·  " : "") + phase;
  }

  /* Resolve a team's two drafted country flags (emoji) from the draft
     map + the field index. Returns [] pre-draft or for empty rosters. */
  function teamFlags(hub, abbr) {
    var byTeam = (hub.draft && hub.draft.countriesByTeam) || {};
    var byId = (hub.field && hub.field.byId) || {};
    var ids = byTeam[abbr] || [];
    var flags = [];
    ids.forEach(function (id) {
      var c = byId[id];
      if (c && c.flag) flags.push(c.flag);
      else if (c && c.id) flags.push(c.id);
    });
    return flags;
  }

  /* ---------------- canvas primitives ---------------- */

  function roundedRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function goldLine(g, x1, x2, y) {
    var grad = g.createLinearGradient(x1, 0, x2, 0);
    grad.addColorStop(0, "rgba(200,150,56,0)");
    grad.addColorStop(0.5, "rgba(200,150,56,0.9)");
    grad.addColorStop(1, "rgba(200,150,56,0)");
    g.strokeStyle = grad;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x1, y + 0.5);
    g.lineTo(x2, y + 0.5);
    g.stroke();
  }

  /* Canvas has no letter-spacing — draw the eyebrow char by char. */
  function drawTracked(g, text, centerX, y, tracking) {
    var chars = text.split("");
    var total = -tracking;
    chars.forEach(function (ch) { total += g.measureText(ch).width + tracking; });
    var x = centerX - total / 2;
    var prevAlign = g.textAlign;
    g.textAlign = "left";
    chars.forEach(function (ch) {
      g.fillText(ch, x, y);
      x += g.measureText(ch).width + tracking;
    });
    g.textAlign = prevAlign;
  }

  function fitText(g, text, maxWidth) {
    if (g.measureText(text).width <= maxWidth) return text;
    var t = text;
    while (t.length > 1 && g.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
    return t + "…";
  }

  /* ---------------- card sections ---------------- */

  function drawBackground(g) {
    var bg = g.createLinearGradient(0, 0, 0, CARD_H);
    bg.addColorStop(0, "#140d06");
    bg.addColorStop(0.5, "#0d0905");
    bg.addColorStop(1, "#0a0603");
    g.fillStyle = bg;
    g.fillRect(0, 0, CARD_W, CARD_H);

    var glow = g.createRadialGradient(CARD_W / 2, 80, 0, CARD_W / 2, 80, 760);
    glow.addColorStop(0, "rgba(200,150,56,0.10)");
    glow.addColorStop(1, "rgba(200,150,56,0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, CARD_W, 560);

    roundedRect(g, 24, 24, CARD_W - 48, CARD_H - 48, 28);
    g.strokeStyle = "rgba(212,168,84,0.35)";
    g.lineWidth = 2;
    g.stroke();
  }

  function drawHeader(g, hub) {
    g.fillStyle = GOLD_3;
    g.font = "700 30px " + SERIF;
    drawTracked(g, "THE LEAGUE", CARD_W / 2, 150, 12);

    var grad = g.createLinearGradient(0, 170, 0, 260);
    grad.addColorStop(0, GOLD_1);
    grad.addColorStop(0.45, "#f3d98a");
    grad.addColorStop(1, GOLD_3);
    g.fillStyle = grad;
    g.font = "900 82px " + SERIF;
    g.textAlign = "center";
    g.fillText("WC26 Knockout Standings", CARD_W / 2, 252);

    g.fillStyle = DIM;
    g.font = "500 30px " + SANS;
    g.fillText(subtitleText(hub), CARD_W / 2, 314);
    g.textAlign = "left";

    goldLine(g, 96, CARD_W - 96, 352);
  }

  function drawRow(g, hub, row, index) {
    var top = ROWS_TOP + index * ROW_H;
    var yc = top + ROW_H / 2;
    var team = row.team || {};
    var accent = safeAccent(team.accent);
    var nameMax = CHIP_X - 20 - NAME_X;

    if (index > 0) {
      g.strokeStyle = "rgba(212,168,84,0.15)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(MARGIN, top + 0.5);
      g.lineTo(RIGHT_X, top + 0.5);
      g.stroke();
    }

    /* No. 1 pick: subtle gold wash behind the whole row. */
    if (row.rank === 1) {
      var hi = g.createLinearGradient(54, 0, RIGHT_X + 18, 0);
      hi.addColorStop(0, "rgba(253,243,207,0.12)");
      hi.addColorStop(1, "rgba(200,150,56,0.02)");
      roundedRect(g, 54, top + 5, CARD_W - 108, ROW_H - 10, 12);
      g.fillStyle = hi;
      g.fill();
    }

    /* Viewer's team: accent bar on the left edge. */
    if (team.isMine) {
      roundedRect(g, 40, top + 12, 10, ROW_H - 24, 5);
      g.fillStyle = accent;
      g.fill();
    }

    g.textAlign = "right";
    g.fillStyle = accent;
    g.font = "900 40px " + SERIF;
    g.fillText(String(row.rank), 148, yc + 14);

    g.textAlign = "left";
    g.font = "italic 800 30px " + SANS;
    var shownName = fitText(g, String(team.name || "").toUpperCase(), nameMax);
    g.fillStyle = TEXT;
    g.fillText(shownName, NAME_X, yc - 4);
    if (row.rank === 1) {
      var nameWidth = g.measureText(shownName).width;
      g.font = "26px " + SANS;
      g.fillText("👑", NAME_X + nameWidth + 12, yc - 4);
    }

    var mgr = managerLine(team);
    if (mgr) {
      g.font = "500 21px " + SANS;
      g.fillStyle = FAINT;
      g.fillText(fitText(g, mgr, nameMax), NAME_X, yc + 25);
    }

    /* Drafted-countries chip: the team's 2 country flags (emoji). Falls
       back to a "—" placeholder pre-draft / for an empty roster. */
    roundedRect(g, CHIP_X, yc - 21, CHIP_W, 42, 21);
    g.fillStyle = "rgba(34,24,12,0.9)";
    g.fill();
    g.strokeStyle = "rgba(138,100,32,0.9)";
    g.lineWidth = 1.5;
    g.stroke();
    g.textAlign = "center";
    var flags = teamFlags(hub, team.abbr);
    if (flags.length) {
      g.font = "26px " + SANS;
      g.fillStyle = TEXT;
      g.fillText(flags.join("  "), CHIP_X + CHIP_W / 2, yc + 9);
    } else {
      g.font = "700 20px " + SERIF;
      g.fillStyle = FAINT;
      g.fillText("—", CHIP_X + CHIP_W / 2, yc + 7);
    }

    /* Primary stat is now total knockout points (advance + goal bonus);
       the subline reports how far this team's run has reached. */
    var pts = row.points;
    var ptsText = (typeof pts === "number" && pts % 1 !== 0)
      ? pts.toFixed(1) : String(pts);
    g.textAlign = "right";
    g.font = "900 40px " + SERIF;
    g.fillStyle = GOLD_1;
    g.fillText(ptsText, RIGHT_X, yc + 1);
    g.font = "600 19px " + SANS;
    g.fillStyle = FAINT;
    var reached = row.reached && row.reached !== "—" ? row.reached : null;
    var subline;
    if (reached === "Champion") subline = "🏆 Champion";
    else if (reached) subline = "to " + reached;
    else subline = "pts";
    g.fillText(subline, RIGHT_X, yc + 29);
    g.textAlign = "left";
  }

  function drawFooter(g) {
    goldLine(g, 96, CARD_W - 96, 1262);
    g.textAlign = "center";
    g.font = "600 26px " + SANS;
    g.fillStyle = FAINT;
    g.fillText(SITE_LABEL + "  ·  ⚽", CARD_W / 2, 1312);
    g.textAlign = "left";
  }

  function drawCard(hub) {
    var canvas = document.createElement("canvas");
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    var g = canvas.getContext("2d");
    if (!g) throw new Error("2d context unavailable");
    drawBackground(g);
    drawHeader(g, hub);
    var rows = hub.standings.slice(0, 12);
    rows.forEach(function (row, i) { drawRow(g, hub, row, i); });
    drawFooter(g);
    return canvas;
  }

  /* ---------------- export + share ---------------- */

  function triggerDownload(url, revoke) {
    var a = document.createElement("a");
    a.href = url;
    a.download = FILE_NAME;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (revoke) {
      window.setTimeout(function () {
        try { URL.revokeObjectURL(url); } catch (err) { /* already gone */ }
      }, REVOKE_DELAY_MS);
    }
  }

  function downloadBlob(blob, btn) {
    try {
      triggerDownload(URL.createObjectURL(blob), true);
      finishOk(btn);
    } catch (err) {
      console.error("Share card download failed:", err);
      finishError(btn);
    }
  }

  function deliver(blob, btn) {
    var file = null;
    try {
      file = new File([blob], FILE_NAME, { type: "image/png" });
    } catch (err) {
      file = null; /* old browsers without the File constructor */
    }
    var canShareFile = false;
    if (file && navigator.share && navigator.canShare) {
      try { canShareFile = navigator.canShare({ files: [file] }); } catch (err) { canShareFile = false; }
    }
    if (!canShareFile) {
      downloadBlob(blob, btn);
      return;
    }
    try {
      navigator.share({ title: "WC26 Knockout Standings", files: [file] })
        .then(function () { finishOk(btn); })
        .catch(function (err) {
          /* User closing the sheet is fine; anything else gets the file. */
          if (err && err.name === "AbortError") finishOk(btn);
          else downloadBlob(blob, btn);
        });
    } catch (err) {
      downloadBlob(blob, btn);
    }
  }

  function exportPng(canvas, btn) {
    if (typeof canvas.toBlob === "function") {
      try {
        canvas.toBlob(function (blob) {
          if (blob) deliver(blob, btn);
          else finishError(btn);
        }, "image/png");
        return;
      } catch (err) {
        /* fall through to data-URL download */
      }
    }
    try {
      triggerDownload(canvas.toDataURL("image/png"), false);
      finishOk(btn);
    } catch (err) {
      console.error("Share card export failed:", err);
      finishError(btn);
    }
  }

  function generate(btn) {
    if (generating) return;
    var hub = window.Hub ? window.Hub.ctx() : null;
    if (!hub || !hub.standings || !hub.standings.length) {
      finishError(btn);
      return;
    }
    generating = true;
    if (restoreTimer) window.clearTimeout(restoreTimer);
    setBusy(btn);
    var canvas;
    try {
      canvas = drawCard(hub);
    } catch (err) {
      console.error("Share card draw failed:", err);
      finishError(btn);
      return;
    }
    exportPng(canvas, btn);
  }

  /* ---------------- wiring (one delegated listener, bound once) ---------------- */

  document.addEventListener("click", function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var btn = target.closest("[data-sc-action]");
    if (!btn || btn.getAttribute("data-sc-action") !== "card") return;
    generate(btn);
  });

  function render(ctx) {
    if (!ctx || !ctx.standings || !ctx.bracket || !ctx.draft) return;
    if (!ctx.standings.length) return;
    try {
      ensureButton();
    } catch (err) {
      console.error("Share card render failed:", err);
    }
  }

  if (window.Hub && typeof window.Hub.onRender === "function") {
    window.Hub.onRender(render);
  }
})();
