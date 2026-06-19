/* The Race — standings-rank history bump chart at the top of the Stats tab.
   Replays every FINISHED bracket match (ctx.bracket.rounds, R32 → Final) in
   round order, awarding each round's advancement points to the team that
   drafted the winning country, snapshots the standings after each round
   resolves, and draws the rank paths as an inline SVG bump chart. Pure
   overlay: never mutates the bracket/teams. The round-by-round replay is
   cached by a fingerprint of the finished bracket matches so the ~2-minute
   auto re-renders stay cheap; the pinned-team highlight lives in module
   scope (+ localStorage) so it survives them. */

(function () {
  "use strict";

  var STORE_KEY = "wc26ko.raceHighlight";
  var FALLBACK_ACCENT = "#c89638";

  /* Chart geometry, in viewBox units (1 unit = 1px at native scale). */
  var LEFT = 46;    /* gutter for the rank numbers */
  var STEP = 90;    /* horizontal gap between snapshots */
  var RIGHT = 78;   /* gutter for the abbr tags at the line ends */
  var TOP = 28;
  var BOTTOM = 46;  /* room for the x-axis round labels */
  var HEIGHT = 380;

  var wired = false;        /* delegated click listener bound once */
  var lastFinger = null;    /* cache key for the replay below */
  var snapshots = [];       /* [{ label, ranks: { abbr: rank } }] */
  var highlightAbbr = null; /* pinned team — survives re-renders */

  try {
    highlightAbbr = localStorage.getItem(STORE_KEY) || null;
  } catch (err) { /* private mode — start unpinned */ }

  /* ---------------- replay ---------------- */

  function isDone(mt) {
    return mt && !!mt.winnerId;
  }

  /* Rounds in bracket order (R32 → Final), defensively sorted by ordinal. */
  function roundsInOrder(ctx) {
    var rounds = (ctx.bracket && ctx.bracket.rounds) || [];
    return rounds.slice().sort(function (a, b) {
      return (a.ordinal || 0) - (b.ordinal || 0);
    });
  }

  /* Cheap change detector: rebuild the replay only when results moved. */
  function fingerprint(ctx) {
    var n = 0;
    var pts = 0;
    roundsInOrder(ctx).forEach(function (round) {
      (round.matches || []).forEach(function (mt) {
        if (!isDone(mt)) return;
        n += 1;
        pts += round.points || 0;
      });
    });
    return n + "|" + pts + "|" + ctx.teams.length;
  }

  /* Same ordering as the live standings: advancement points desc, then the
     stable draft-board team order as the tiebreak. (Goal bonus is omitted
     from the replay — advancement points drive the rank movement.) */
  function rankMap(ctx, pointsBy) {
    var rows = ctx.teams.map(function (t, i) {
      return { abbr: t.abbr, idx: i, p: pointsBy[t.abbr] || 0 };
    });
    rows.sort(function (a, b) {
      if (b.p !== a.p) return b.p - a.p;
      return a.idx - b.idx;
    });
    var ranks = {};
    rows.forEach(function (row, i) { ranks[row.abbr] = i + 1; });
    return ranks;
  }

  /* Replay finished bracket matches round by round — O(rounds × teams). */
  function buildSnapshots(ctx) {
    var owners = (ctx.draft && ctx.draft.ownersByCountry) || {};
    var pointsBy = {}; /* team abbr -> cumulative advancement points */
    var snaps = [{ label: "Draft", ranks: rankMap(ctx, pointsBy) }];

    roundsInOrder(ctx).forEach(function (round) {
      var resolved = 0;
      (round.matches || []).forEach(function (mt) {
        if (!isDone(mt)) return;
        resolved += 1;
        var abbr = owners[mt.winnerId];
        if (abbr) pointsBy[abbr] = (pointsBy[abbr] || 0) + (round.points || 0);
      });
      /* Only snapshot a round once at least one of its matches has resolved,
         so the chart adds a column per completed round, not per scheduled one. */
      if (resolved > 0) {
        var label = round.name || (ctx.helpers.roundLabel
          ? ctx.helpers.roundLabel(round.name) : "Round");
        snaps.push({ label: label, ranks: rankMap(ctx, pointsBy) });
      }
    });

    return snaps;
  }

  /* ---------------- chart svg ---------------- */

  function yFor(rank, teamCount) {
    var plotH = HEIGHT - TOP - BOTTOM;
    return Math.round((TOP + (rank - 1) * (plotH / Math.max(teamCount - 1, 1))) * 10) / 10;
  }

  function xFor(i) { return LEFT + i * STEP; }

  function gridHtml(ctx) {
    var esc = ctx.helpers.esc;
    var teamCount = ctx.teams.length;
    var endX = xFor(snapshots.length - 1);
    var out = "";
    var r;
    var y;
    for (r = 1; r <= teamCount; r++) {
      y = yFor(r, teamCount);
      out += '<line class="rc-grid" x1="' + LEFT + '" y1="' + y + '" x2="' + endX + '" y2="' + y + '"></line>' +
        '<text class="rc-rank" x="' + (LEFT - 12) + '" y="' + y + '" dy="0.32em" text-anchor="end">' + r + "</text>";
    }
    snapshots.forEach(function (snap, i) {
      out += '<text class="rc-x' + (i === 0 ? " start" : "") + '" x="' + xFor(i) + '" y="' + (HEIGHT - 18) +
        '" text-anchor="middle">' + esc(snap.label) + "</text>";
    });
    return out;
  }

  function teamLayer(ctx, team) {
    var esc = ctx.helpers.esc;
    var teamCount = ctx.teams.length;
    var accent = esc(team.accent || FALLBACK_ACCENT);
    var pts = [];
    var dots = "";
    var lastY = TOP;
    snapshots.forEach(function (snap, i) {
      var rank = snap.ranks[team.abbr];
      if (!rank) return; /* team missing from a snapshot — skip the point */
      var x = xFor(i);
      var y = yFor(rank, teamCount);
      pts.push(x + "," + y);
      dots += '<circle class="rc-dot" cx="' + x + '" cy="' + y + '" r="' +
        (team.isMine ? 4.5 : 3.5) + '" fill="' + accent + '"></circle>';
      lastY = y;
    });
    if (!pts.length) return "";
    var line = pts.join(" ");
    var cls = "rc-team" + (team.isMine ? " rc-mine" : "") +
      (team.abbr === highlightAbbr ? " is-hot" : "");
    return '<g class="' + cls + '" data-abbr="' + esc(team.abbr) + '">' +
      /* fat invisible stroke first = easy finger target on phones */
      '<polyline class="rc-hit" points="' + line + '"></polyline>' +
      '<polyline class="rc-path" points="' + line + '" stroke="' + accent + '"></polyline>' +
      dots +
      '<text class="rc-tag" x="' + (xFor(snapshots.length - 1) + 10) + '" y="' + lastY +
      '" dy="0.32em" fill="' + accent + '">' + esc(team.abbr) + (team.isMine ? " ⭐" : "") + "</text>" +
      "</g>";
  }

  /* Draw order: plain lines first, then mine, then the pinned team on top. */
  function layerWeight(team) {
    var w = 0;
    if (team.isMine) w += 1;
    if (team.abbr === highlightAbbr) w += 2;
    return w;
  }

  function chartHtml(ctx) {
    var width = xFor(snapshots.length - 1) + RIGHT;
    var hot = false;
    ctx.teams.forEach(function (t) { if (t.abbr === highlightAbbr) hot = true; });

    var layers = ctx.teams.slice()
      .sort(function (a, b) { return layerWeight(a) - layerWeight(b); })
      .map(function (t) { return teamLayer(ctx, t); })
      .join("");

    return '<div class="rc-scroll">' +
      '<svg class="rc-svg' + (hot ? " rc-has-hot" : "") + '" viewBox="0 0 ' + width + " " + HEIGHT +
      '" style="min-width:' + width + 'px" preserveAspectRatio="xMinYMid meet" role="img"' +
      ' aria-label="Bump chart of the knockout standings after each bracket round">' +
      gridHtml(ctx) + layers + "</svg></div>";
  }

  /* ---------------- movers ---------------- */

  function chipHtml(esc, cls, icon, team, delta) {
    return '<button type="button" class="rc-chip ' + cls + '" data-abbr="' + esc(team.abbr) +
      '" aria-label="Highlight ' + esc(team.name) + ' on the chart">' +
      icon + " <b>" + esc(team.abbr) + "</b> " + delta + "</button>";
  }

  function moversHtml(ctx) {
    if (snapshots.length < 2) return "";
    var esc = ctx.helpers.esc;
    var prev = snapshots[snapshots.length - 2];
    var curr = snapshots[snapshots.length - 1];
    var riser = null;
    var faller = null;
    ctx.teams.forEach(function (t) {
      var was = prev.ranks[t.abbr];
      var now = curr.ranks[t.abbr];
      if (!was || !now) return;
      var d = was - now; /* positive = climbed the standings */
      if (d > 0 && (!riser || d > riser.d)) riser = { team: t, d: d };
      if (d < 0 && (!faller || d < faller.d)) faller = { team: t, d: d };
    });
    var chips = "";
    if (riser) chips += chipHtml(esc, "rc-up", "📈", riser.team, "+" + riser.d);
    if (faller) chips += chipHtml(esc, "rc-down", "📉", faller.team, String(faller.d));
    if (!chips) chips = '<span class="rc-chip rc-flat">↔ No places changed after ' + esc(curr.label) + "</span>";
    return '<div class="rc-movers">' +
      '<span class="rc-movers-label">Movers · ' + esc(curr.label) + "</span>" + chips +
      "</div>";
  }

  /* ---------------- interaction (bound once) ---------------- */

  function applyHighlight(host) {
    var svg = host.querySelector(".rc-svg");
    if (!svg) return;
    var nodes = svg.querySelectorAll(".rc-team");
    var hot = false;
    var i;
    for (i = 0; i < nodes.length; i++) {
      if (highlightAbbr && nodes[i].getAttribute("data-abbr") === highlightAbbr) {
        nodes[i].classList.add("is-hot");
        hot = true;
      } else {
        nodes[i].classList.remove("is-hot");
      }
    }
    if (hot) svg.classList.add("rc-has-hot");
    else svg.classList.remove("rc-has-hot");
  }

  function wire(host) {
    if (wired) return;
    wired = true;
    host.addEventListener("click", function (e) {
      var target = e.target && e.target.closest ? e.target.closest("[data-abbr]") : null;
      if (!target) return;
      var abbr = target.getAttribute("data-abbr");
      highlightAbbr = highlightAbbr === abbr ? null : abbr;
      try {
        if (highlightAbbr) localStorage.setItem(STORE_KEY, highlightAbbr);
        else localStorage.removeItem(STORE_KEY);
      } catch (err) { /* private mode — pin still works for this session */ }
      applyHighlight(host);
    });
  }

  /* ---------------- render ---------------- */

  function headHtml() {
    return '<div class="rc-head">🏁 The Race · Standings Over Time</div>';
  }

  function emptyHtml() {
    return '<div class="rc-panel"><div class="rc-empty">' +
      "The race starts with the first knockout match result." +
      '<div class="rc-empty-sub">As bracket rounds finish, every team’s rise (and fall) in points charts here, round by round.</div>' +
      "</div></div>";
  }

  function bodyHtml(ctx) {
    return '<div class="rc-panel">' +
      chartHtml(ctx) +
      moversHtml(ctx) +
      '<p class="rc-foot">Standings rank after each bracket round — points from your drafted countries’ wins, draft order as the tiebreak. ' +
      "Tap a line or chip to pin a team.</p>" +
      "</div>";
  }

  /* The Stats panel is hidden on first paint, so scrollWidth is 0 and any
     right-edge snap is lost. Defer it until the panel is actually visible. */
  var pendingSnap = true;
  var snapWired = false;

  function snapToLatest(host) {
    var scroll = host.querySelector(".rc-scroll");
    if (!scroll || host.offsetParent === null) return;
    scroll.scrollLeft = scroll.scrollWidth;
    pendingSnap = false;
  }

  function wireSnap() {
    if (snapWired) return;
    snapWired = true;
    document.addEventListener("click", function (e) {
      if (!pendingSnap) return;
      var tab = e.target.closest('.tab[data-tab="stats"]');
      if (!tab) return;
      window.requestAnimationFrame(function () {
        var host = document.getElementById("race-host");
        if (host) snapToLatest(host);
      });
    });
  }

  function render(ctx) {
    var host = document.getElementById("race-host");
    if (!host) return;
    try {
      wire(host);
      wireSnap();
      if (!ctx || !ctx.standings || !ctx.bracket || !ctx.draft) return;
      if (!ctx.teams || !ctx.teams.length || !ctx.helpers) {
        host.innerHTML = "";
        return;
      }
      var finger = fingerprint(ctx);
      if (finger !== lastFinger) {
        lastFinger = finger;
        snapshots = buildSnapshots(ctx);
      }

      /* innerHTML swap resets the chart's scroll — keep the reader's place
         (but a hidden panel always reads 0, which is not a reader's place). */
      var visible = host.offsetParent !== null;
      var oldScroll = host.querySelector(".rc-scroll");
      var savedLeft = visible && oldScroll ? oldScroll.scrollLeft : null;

      var hasRounds = snapshots.length >= 2;
      host.innerHTML = '<section class="rc-block">' + headHtml() +
        (hasRounds ? bodyHtml(ctx) : emptyHtml()) + "</section>";

      var scroll = host.querySelector(".rc-scroll");
      if (scroll) {
        if (!visible) {
          pendingSnap = true;
        } else if (savedLeft !== null && !pendingSnap) {
          scroll.scrollLeft = savedLeft;
        } else {
          /* First visible paint lands on the latest snapshot (right edge). */
          snapToLatest(host);
        }
      }
    } catch (err) {
      console.error("The Race render failed:", err);
    }
  }

  if (window.Hub) Hub.onRender(render);
})();
