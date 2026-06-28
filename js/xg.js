/* Expected Goals (xG) tab: a strength-based projection of the final
   knockout standings. Each fantasy team's drafted countries are tracked
   through ctx.bracket; every unresolved match a drafted country still
   appears in gets an xG forecast from per-country Elo ratings (goal share
   follows Elo win expectancy, lopsided pairings inflate the total). The
   model's win probability for that country, times the round's advancement
   points, is the expected points still on the table — scaled by a clamped
   bracket-pace multiplier (how the draw has actually broken vs the model's
   expectation) and added to the points already banked.

   Also exposes window.XG.remainingPace(ctx, abbr) so the bracket Monte
   Carlo can swap its flat tournament-average prior for a strength-aware
   one. Pure display plus one delegated click (team picker); renders into
   #xg-host. */

(function () {
  "use strict";

  /* ---------------- tuning constants ---------------- */

  var MATCH_GOALS = 2.6;     // expected total goals, evenly matched game
  var MISMATCH_BOOST = 0.8;  // extra total goals at maximum Elo mismatch
  var LAMBDA_MIN = 0.2;      // floor on one side's xG (nobody is hopeless)
  var LAMBDA_MAX = 3.6;      // cap on one side's xG (knockout, not FIFA 95)
  var PACE_PRIOR = 1;        // pseudo-matches anchoring the bracket-pace multiplier
  var PACE_MIN = 0.7;        // pace multiplier clamp — a brutal draw
  var PACE_MAX = 1.3;        // pace multiplier clamp — a kind draw
  var INPLAY_W = 0.45;       // share of a live match's xG / advance still to come
  var SPOTLIGHT_MAX = 5;     // remaining matches shown in Match Spotlight
  var FALLBACK_AC = "#c89638";

  var ROUND_ORDINAL = { "R32": 1, "R16": 2, "QF": 3, "SF": 4, "Final": 5, "Champion": 6 };

  /* World Football Elo ratings (eloratings.net), spring 2026 snapshot.
     These are the model's only opinion about team strength — tweak any
     number, commit, and every projection re-derives itself. Keys must
     match the country names in js/data.js exactly. */
  var RATINGS = {
    /* A */ "Mexico": 1820, "South Africa": 1550, "South Korea": 1790, "Czech Republic": 1740,
    /* B */ "Canada": 1790, "Bosnia & Herzegovina": 1610, "Qatar": 1570, "Switzerland": 1850,
    /* C */ "Brazil": 2030, "Morocco": 1940, "Haiti": 1465, "Scotland": 1740,
    /* D */ "United States": 1790, "Paraguay": 1810, "Australia": 1730, "Türkiye": 1850,
    /* E */ "Germany": 1940, "Curaçao": 1560, "Ivory Coast": 1700, "Ecuador": 1900,
    /* F */ "Netherlands": 1970, "Japan": 1880, "Sweden": 1730, "Tunisia": 1680,
    /* G */ "Belgium": 1920, "Egypt": 1760, "Iran": 1790, "New Zealand": 1600,
    /* H */ "Spain": 2180, "Cape Verde": 1620, "Saudi Arabia": 1640, "Uruguay": 1880,
    /* I */ "France": 2060, "Senegal": 1850, "Iraq": 1600, "Norway": 1950,
    /* J */ "Argentina": 2120, "Algeria": 1750, "Austria": 1860, "Jordan": 1640,
    /* K */ "Portugal": 2010, "DR Congo": 1690, "Uzbekistan": 1700, "Colombia": 1950,
    /* L */ "England": 2080, "Croatia": 1880, "Ghana": 1650, "Panama": 1690
  };

  /* Swap-safety net: if a FIELD country has no exact RATINGS key (e.g. a real
     qualifier whose name is spelled differently than above), fall back to a
     mid-tier rating instead of collapsing the whole match to a coinflip. When
     the real R32 field is wired in, sanity-check that every FIELD[i].name has a
     RATINGS entry (see the swap checklist in README / js/data.js). */
  var FALLBACK_RATING = 1700;
  function ratingFor(name) {
    var r = RATINGS[name];
    return (typeof r === "number") ? r : FALLBACK_RATING;
  }

  var bound = false; // delegated listener attached once

  /* ---------------- the xG model ---------------- */

  function clampLambda(x) {
    return Math.min(Math.max(x, LAMBDA_MIN), LAMBDA_MAX);
  }

  /* Win expectancy for the home side from the Elo gap. */
  function winProb(homeName, awayName) {
    var rh = ratingFor(homeName);
    var ra = ratingFor(awayName);
    return 1 / (1 + Math.pow(10, (ra - rh) / 400));
  }

  /* xG for one fixture: win expectancy from the Elo gap sets each side's
     share of the goals; mismatches push the expected total up. */
  function fixtureXg(homeName, awayName) {
    var rh = ratingFor(homeName);
    var ra = ratingFor(awayName);
    var w = 1 / (1 + Math.pow(10, (ra - rh) / 400));
    var total = MATCH_GOALS + MISMATCH_BOOST * Math.abs(w - 0.5) * 2;
    var h = clampLambda(total * w);
    var a = clampLambda(total * (1 - w));
    return { home: h, away: a, total: h + a };
  }

  /* ---------------- bracket helpers ---------------- */

  function pointsFor(round) {
    if (round && typeof round.points === "number") return round.points;
    var cfg = (typeof POINTS_CONFIG !== "undefined" && POINTS_CONFIG) || {};
    return (round && cfg[round.name]) || 0;
  }

  /* Set of countryIds this fantasy team drafted. */
  function ownedIds(ctx, abbr) {
    var set = {};
    var ids = (ctx.draft && ctx.draft.countriesByTeam && ctx.draft.countriesByTeam[abbr]) || [];
    ids.forEach(function (id) { set[id] = true; });
    return set;
  }

  /* Whether a bracket match still has a result to come. */
  function isResolved(mt) {
    var FIN = (window.Live && Live.FINISHED) || {};
    return !!mt.winnerId || !!FIN[mt.status];
  }
  function isLive(mt) {
    var INPLAY = (window.Live && Live.INPLAY) || {};
    return !!INPLAY[mt.status];
  }

  /* One team's model state across the bracket: advancement points
     xG-projected as still to come, the total xG of the matches it still
     has a stake in (for the Monte Carlo prior), and the remaining matches
     themselves. A match is counted once per drafted country still in it. */
  function teamOutlook(ctx, abbr) {
    var owned = ownedIds(ctx, abbr);
    var out = { remainAdvance: 0, remainW: 0, remainXg: 0, remaining: [] };
    var rounds = (ctx.bracket && ctx.bracket.rounds) || [];

    rounds.forEach(function (round) {
      var pts = pointsFor(round);
      round.matches.forEach(function (mt) {
        var homeId = mt.home && mt.home.countryId;
        var awayId = mt.away && mt.away.countryId;
        if (!homeId || !awayId) return;                  // slot not filled yet
        if (!owned[homeId] && !owned[awayId]) return;    // none of ours here
        if (isResolved(mt)) return;                      // already banked elsewhere

        var xg = fixtureXg(mt.home.name, mt.away.name);
        var pHome = winProb(mt.home.name, mt.away.name);
        var live = isLive(mt);
        var w = live ? INPLAY_W : 1;

        // Expected advancement points this match still offers our team:
        // each owned side's win probability × the round's points.
        var pMine = 0;
        if (owned[homeId]) pMine += pHome;
        if (owned[awayId]) pMine += (1 - pHome);

        out.remainAdvance += pMine * pts * w;
        out.remainXg += xg.total * w;
        out.remainW += w;
        out.remaining.push({
          match: mt,
          xg: xg,
          live: live,
          round: round,
          points: pts,
          expPts: pMine * pts
        });
      });
    });

    return out;
  }

  /* Bracket-pace adjustment: how a team's banked points compare with what
     the model would expect from the rounds it has reached, anchored by a
     prior and clamped so one upset can't run away with the projection. */
  function paceFactor(row) {
    var reachedOrd = ROUND_ORDINAL[row.reached] || 0;
    var expected = Math.max(reachedOrd, 0);
    var actual = (typeof row.advancePoints === "number" ? row.advancePoints : 0) / 5;
    var f = (actual + PACE_PRIOR) / (expected + PACE_PRIOR);
    return Math.min(Math.max(f, PACE_MIN), PACE_MAX);
  }

  /* Strength-aware prior for the Monte Carlo: the model's expected total
     goals per remaining bracket match involving this team (un-adjusted for
     pace — the caller blends in observed form itself). */
  function remainingPace(ctx, abbr) {
    if (!ctx || !ctx.bracket) return MATCH_GOALS;
    var o = teamOutlook(ctx, abbr);
    if (!o.remainW) return MATCH_GOALS;
    return o.remainXg / o.remainW;
  }

  /* ---------------- projection ---------------- */

  function buildProjection(ctx) {
    var rows = ctx.standings.map(function (row) {
      var abbr = row.team && row.team.abbr;
      var o = teamOutlook(ctx, abbr);
      var factor = paceFactor(row);
      var adjRemain = o.remainAdvance * factor;
      var nowPoints = typeof row.points === "number" ? row.points : 0;
      return {
        team: row.team,
        nowRank: row.rank,
        points: nowPoints,
        remainPts: adjRemain,
        proj: nowPoints + adjRemain,
        aliveCount: row.aliveCount || 0,
        reached: row.reached || "—",
        factor: factor,
        remaining: o.remaining
      };
    });

    var sorted = rows.slice().sort(function (a, b) {
      return (b.proj - a.proj) || (a.nowRank - b.nowRank);
    });
    return sorted.map(function (r, i) {
      return Object.assign({}, r, { projRank: i + 1, delta: r.nowRank - (i + 1) });
    });
  }

  /* Remaining bracket matches across all teams, biggest expected advancement
     swing first — the matches that reshape the standings. Deduped by match
     id so a match drafted on both sides is only spotlighted once. */
  function spotlight(rows) {
    var picks = [];
    var seen = {};
    rows.forEach(function (r) {
      r.remaining.forEach(function (rem) {
        var key = rem.match.id;
        if (seen[key]) return;
        seen[key] = true;
        picks.push({ team: r.team, match: rem.match, xg: rem.xg, live: rem.live,
                     round: rem.round, expPts: rem.expPts });
      });
    });
    return picks.sort(function (a, b) {
      return (b.expPts - a.expPts) || (b.xg.total - a.xg.total);
    }).slice(0, SPOTLIGHT_MAX);
  }

  /* ---------------- formatting ---------------- */

  function fmt1(x) { return x.toFixed(1); }

  function moveHtml(delta) {
    if (delta > 0) return '<span class="xg-move up">▲' + delta + "</span>";
    if (delta < 0) return '<span class="xg-move down">▼' + (-delta) + "</span>";
    return '<span class="xg-move flat">—</span>';
  }

  function findMine(rows) {
    var mine = null;
    rows.forEach(function (r) { if (r.team && r.team.isMine) mine = r; });
    return mine;
  }

  /* ---------------- hero cards ---------------- */

  function cardHtml(label, value, detail, cls) {
    return '<div class="xg-card">' +
      '<div class="xg-card-label">' + label + "</div>" +
      '<div class="xg-card-value' + (cls ? " " + cls : "") + '">' + value + "</div>" +
      '<div class="xg-card-detail">' + detail + "</div>" +
      "</div>";
  }

  function heroHtml(ctx, rows) {
    var esc = ctx.helpers.esc;
    var ord = ctx.helpers.ordinal;
    var top = rows[0];

    var first = cardHtml("Projected No. 1 seed", esc(top.team.name),
      "proj " + fmt1(top.proj) + " points · now " + top.nowRank + ord(top.nowRank), "name");

    var mine = findMine(rows);
    var second;
    if (mine) {
      second = cardHtml("Your projected seed", mine.projRank + ord(mine.projRank) + " seed",
        "⭐ " + esc(mine.team.name) + " · now " + mine.nowRank + ord(mine.nowRank) + " seed");
    } else {
      var hint = window.MyTeam
        ? '<button type="button" class="xg-link" data-xg-act="pick">Pick your team</button> to see your projection'
        : "no team selected";
      second = cardHtml("Your projected seed", "&mdash;", hint, "dim");
    }

    var mover = null;
    rows.forEach(function (r) {
      if (r.delta !== 0 && (!mover || Math.abs(r.delta) > Math.abs(mover.delta))) mover = r;
    });
    var third = mover
      ? cardHtml("Biggest projected mover",
          (mover.delta > 0 ? "▲" : "▼") + Math.abs(mover.delta),
          esc(mover.team.name) + " · " + mover.nowRank + ord(mover.nowRank) +
            " → " + mover.projRank + ord(mover.projRank),
          mover.delta > 0 ? "up" : "down")
      : cardHtml("Biggest projected mover", "&mdash;", "projection matches the live board", "dim");

    return '<section class="xg-block"><div class="xg-cards">' +
      first + second + third + "</div></section>";
  }

  /* ---------------- projected board ---------------- */

  function boardHtml(ctx, rows) {
    var esc = ctx.helpers.esc;
    var ord = ctx.helpers.ordinal;
    var maxProj = rows.reduce(function (m, r) { return Math.max(m, r.proj); }, 1);

    var body = rows.map(function (r) {
      var bankedPct = Math.min((r.points / maxProj) * 100, 100);
      var expPct = Math.min((r.remainPts / maxProj) * 100, 100 - bankedPct);
      return '<div class="xg-row' + (r.team.isMine ? " mine" : "") +
          '" style="--xg-ac:' + esc(r.team.accent || FALLBACK_AC) + '">' +
        '<span class="xg-rank">' + r.projRank + "<small>" + ord(r.projRank) + "</small></span>" +
        moveHtml(r.delta) +
        '<span class="xg-team"><span class="xg-name">' + esc(r.team.name) +
          (r.team.isMine ? " ⭐" : "") + "</span>" +
          '<span class="xg-sub">now ' +
          r.nowRank + ord(r.nowRank) + " · " + r.aliveCount + " alive</span></span>" +
        '<span class="xg-bar"><span class="xg-bar-banked" style="width:' + bankedPct.toFixed(1) +
          '%"></span><span class="xg-bar-exp" style="width:' + expPct.toFixed(1) + '%"></span></span>' +
        '<span class="xg-proj">' + fmt1(r.proj) +
          "<small>" + fmt1(r.points) + " + " + fmt1(r.remainPts) + " proj</small></span>" +
        "</div>";
    }).join("");

    return '<section class="xg-block">' +
      '<div class="xg-head">📈 Projected Final Board</div>' +
      '<div class="xg-board">' + body + "</div>" +
      '<p class="xg-foot">Projected points = points earned so far (solid) + Elo-based xG advancement ' +
        "for every remaining bracket match, scaled by bracket pace (striped). Arrows compare with the live board.</p>" +
      "</section>";
  }

  /* ---------------- match spotlight ---------------- */

  function spotlightHtml(ctx, rows) {
    var esc = ctx.helpers.esc;
    var picks = spotlight(rows);
    if (!picks.length) return "";

    var body = picks.map(function (m) {
      var mt = m.match;
      var when = m.live
        ? '<span class="xg-mine-live">● LIVE</span>'
        : esc((m.round && m.round.label) || (m.round && m.round.name) || "");
      return '<div class="xg-mine" style="--xg-ac:' + esc(m.team.accent || FALLBACK_AC) + '">' +
        '<span class="xg-mine-match">' + (mt.home.flag || "") + " " + esc(mt.home.name || "TBD") +
          " <em>v</em> " + esc(mt.away.name || "TBD") + " " + (mt.away.flag || "") + "</span>" +
        '<span class="xg-mine-xg">xG ' + fmt1(m.xg.home) + "–" + fmt1(m.xg.away) +
          " · +" + fmt1(m.expPts) + " pts</span>" +
        '<span class="xg-mine-meta">' + when +
          ' <span class="xg-mine-owner">⚽ ' + esc(m.team.abbr) + "</span></span>" +
        "</div>";
    }).join("");

    return '<section class="xg-block">' +
      '<div class="xg-head">⛏️ Match Spotlight · biggest remaining rounds</div>' +
      '<div class="xg-mines">' + body + "</div>" +
      '<p class="xg-foot">The remaining bracket matches with the most expected advancement points on the line — these reshape the standings.</p>' +
      "</section>";
  }

  /* ---------------- render ---------------- */

  function bannerHtml(ctx, rows) {
    var rounds = (ctx.bracket && ctx.bracket.rounds) || [];
    var finished = 0;
    rounds.forEach(function (round) {
      round.matches.forEach(function (mt) { if (isResolved(mt)) finished += 1; });
    });
    if (finished === 0) {
      return '<div class="xg-banner">Bracket not started yet — pure Elo xG on every match, no points banked.</div>';
    }
    var anyLeft = rows.some(function (r) { return r.remaining.length > 0; });
    if (!anyLeft) {
      return '<div class="xg-banner">Bracket complete — the projection IS the final board.</div>';
    }
    return "";
  }

  function onClick(e) {
    var btn = e.target.closest ? e.target.closest("[data-xg-act]") : null;
    if (!btn) return;
    if (btn.getAttribute("data-xg-act") === "pick" &&
        window.MyTeam && typeof MyTeam.open === "function") {
      MyTeam.open();
    }
  }

  function render(ctx) {
    var host = document.getElementById("xg-host");
    if (!host) return;
    try {
      if (!bound) {
        host.addEventListener("click", onClick);
        bound = true;
      }
      if (!ctx || !ctx.standings || !ctx.bracket || !ctx.draft) return;
      if (!ctx.draft.complete) {
        host.innerHTML = '<p class="xg-empty">Waiting for the draft to finish…</p>';
        return;
      }
      if (!ctx.standings.length) {
        host.innerHTML = '<p class="xg-empty">Waiting for bracket data…</p>';
        return;
      }
      var rows = buildProjection(ctx);
      host.innerHTML = '<div class="xg-wrap">' +
        bannerHtml(ctx, rows) +
        heroHtml(ctx, rows) +
        boardHtml(ctx, rows) +
        spotlightHtml(ctx, rows) +
        '<p class="xg-method">Elo-based xG · goal share follows win expectancy · lopsided games raise the ' +
          "total · advancement points = win probability × round value · bracket pace multiplier ×" +
          PACE_MIN + "–" + PACE_MAX + " · ratings hand-tunable in js/xg.js</p>" +
        "</div>";
    } catch (err) {
      console.error("xG render failed:", err);
    }
  }

  window.XG = { fixtureXg: fixtureXg, remainingPace: remainingPace, RATINGS: RATINGS };

  if (window.Hub && typeof window.Hub.onRender === "function") Hub.onRender(render);
})();
