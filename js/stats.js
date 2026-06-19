/* Stats & Records tab: wire-report headlines, the record book,
   per-team draft-roster bracket tracker and goals-by-round bars —
   all derived from the latest Hub ctx. Pure display: no listeners,
   the host is fully rebuilt on every render so repeated calls are safe.
   Knockout model: scoring is advancement points + goal bonuses; cards
   and fouls never score. */

(function () {
  "use strict";

  var WAIT = "waiting for kickoff";
  var SITE_URL = "https://ysawiris.github.io/wc26-knockout-bracket/";

  /* The plain-text headlines from the most recent render, captured so the
     "Copy today's wire" button can flatten them on click. The host is rebuilt
     every render, so we lean on a single delegated document listener (below)
     rather than per-render listeners. */
  var lastWire = null;

  /* ---------------- small utils ---------------- */

  function plural(n, one, many) { return n === 1 ? one : many; }

  /* Strip HTML tags and decode the few entities our headlines emit, for the
     plain-text digest. */
  function stripTags(html) {
    return String(html)
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&mdash;/g, "—");
  }

  /* Clipboard write with a graceful fallback (mirrors board-extras). */
  function clipboardFallback(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok;
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      document.body.removeChild(ta);
      if (ok) resolve();
      else reject(new Error("copy failed"));
    });
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return clipboardFallback(text);
      });
    }
    return clipboardFallback(text);
  }

  function isFinished(fx) { return !!Live.FINISHED[fx.status]; }
  function isInPlay(fx) { return !!Live.INPLAY[fx.status]; }
  function isCounted(fx) { return isFinished(fx) || isInPlay(fx); }
  function hasScore(fx) { return fx.homeGoals != null && fx.awayGoals != null; }

  /* Flatten every bracket match across all rounds. */
  function allMatches(ctx) {
    var out = [];
    (ctx.bracket.rounds || []).forEach(function (round) {
      (round.matches || []).forEach(function (mt) { out.push(mt); });
    });
    return out;
  }

  function teamByAbbr(ctx, abbr) {
    var found = null;
    ctx.teams.forEach(function (t) { if (t.abbr === abbr) found = t; });
    return found;
  }

  function findMineRow(ctx) {
    var mine = null;
    ctx.standings.forEach(function (r) { if (r.team.isMine) mine = r; });
    return mine;
  }

  /* ---------------- headlines (in-tournament) ---------------- */

  function leaderLine(ctx) {
    var esc = ctx.helpers.esc;
    var top = ctx.standings[0];
    var second = ctx.standings[1];
    if (!top) return null;
    var topName = "<b>" + esc(top.team.name) + "</b>";
    var pts = top.points;

    if (second && second.points === top.points && second.advancePoints === top.advancePoints) {
      return topName + " and <b>" + esc(second.team.name) + "</b> are deadlocked atop the table on " +
        pts + " " + plural(pts, "point", "points") +
        " — somebody's drafted countries need to win one.";
    }
    if (second && second.points === top.points) {
      return topName + " edges the lead on advancement alone — level with <b>" +
        esc(second.team.name) + "</b> at " + pts + " " + plural(pts, "point", "points") + ".";
    }
    if (second) {
      var gap = +(top.points - second.points).toFixed(1);
      return topName + " tops the advancement standings with " + pts + " " + plural(pts, "point", "points") +
        " — " + (gap >= 8
          ? "daylight to 2nd."
          : "just " + gap + " " + plural(gap, "point", "points") + " clear of <b>" + esc(second.team.name) + "</b>.");
    }
    return topName + " tops the advancement standings with " + pts + " " + plural(pts, "point", "points") + ".";
  }

  function tightestGapLine(ctx) {
    var esc = ctx.helpers.esc;
    var s = ctx.standings;
    var best = null;
    for (var i = 1; i < 4 && i + 1 < s.length; i++) {
      var g = +(s[i].points - s[i + 1].points).toFixed(1);
      if (best === null || g < best.gap) best = { gap: g, hi: s[i], lo: s[i + 1] };
    }
    if (!best) return null;
    if (best.gap === 0) {
      return "<b>" + esc(best.hi.team.name) + "</b> and <b>" + esc(best.lo.team.name) +
        "</b> are dead level at " + best.hi.points + " — one knockout result splits them.";
    }
    return "Tightest squeeze in the top half: " + best.gap + " " + plural(best.gap, "point", "points") +
      " between <b>" + esc(best.hi.team.name) + "</b> (" + best.hi.rank + ctx.helpers.ordinal(best.hi.rank) +
      ") and <b>" + esc(best.lo.team.name) + "</b>.";
  }

  /* Celebrate whichever team has carried a country deepest into the bracket. */
  function deepestRunLine(ctx) {
    var esc = ctx.helpers.esc;
    var ROUND_ORD = { "R32": 1, "R16": 2, "QF": 3, "SF": 4, "Final": 5, "Champion": 6 };
    var best = null;
    ctx.standings.forEach(function (row) {
      var ord = ROUND_ORD[row.reached] || 0;
      if (ord <= 0) return;
      if (!best || ord > best.ord) best = { row: row, ord: ord, reached: row.reached };
    });
    if (!best) return null;
    var stage = best.reached === "Champion"
      ? "lifted the trophy 🏆"
      : "have a country live in the <b>" + esc(ctx.helpers.roundLabel(best.reached)) + "</b>";
    return "<b>" + esc(best.row.team.name) + "</b> " + stage + " — the deepest run on the board.";
  }

  /* Spotlight whichever UNDRAFTED country is out-scoring the most drafted teams. */
  function undraftedLine(ctx) {
    var esc = ctx.helpers.esc;
    var best = null;
    ctx.field.list.forEach(function (c) {
      if (c.drafted) return;
      if (!best || c.goals > best.goals) best = { country: c, goals: c.goals };
    });
    if (!best || best.goals <= 0) return null;
    var beaten = ctx.standings.filter(function (r) { return r.goals < best.goals; }).length;
    if (beaten <= 0) return null;
    return "Undrafted " + esc(best.country.name) + " " + best.country.flag + " has " +
      best.goals + " " + plural(best.goals, "goal", "goals") +
      " — more than " + beaten + " drafted " + plural(beaten, "team", "teams") + " 💀";
  }

  function mineLine(ctx) {
    var esc = ctx.helpers.esc;
    var row = findMineRow(ctx);
    if (!row) return null;
    var name = "<b>" + esc(row.team.name) + "</b>";
    var alive = row.aliveCount;
    if (alive === 0) {
      return "⭐ " + name + " sits " + row.rank + ctx.helpers.ordinal(row.rank) +
        " on " + row.points + " " + plural(row.points, "point", "points") +
        " — both drafted countries are out. The board is set.";
    }
    if (row.rank === 1) {
      return "⭐ The lead is " + name + "'s to lose — " + alive + " " +
        plural(alive, "country", "countries") + " still alive to protect it.";
    }
    return "⭐ " + name + " sits " + row.rank + ctx.helpers.ordinal(row.rank) + " with " +
      row.points + " " + plural(row.points, "point", "points") + " — " + alive + " " +
      plural(alive, "country", "countries") + " still in the bracket to climb.";
  }

  function liveLines(ctx) {
    var lines = [];
    [leaderLine, tightestGapLine, deepestRunLine, undraftedLine, mineLine].forEach(function (fn) {
      var line = fn(ctx);
      if (line) lines.push(line);
    });
    return lines;
  }

  /* ---------------- headlines (pre-bracket / draft) ---------------- */

  function preseasonLines(ctx) {
    var esc = ctx.helpers.esc;
    var lines = [];
    var picksIn = ctx.draft.picks.length;
    var slots = ctx.draft.order.length * 2;

    if (!ctx.draft.complete) {
      var left = Math.max(slots - picksIn, 0);
      lines.push("<b>The snake draft is live.</b> " + left + " " + plural(left, "pick", "picks") +
        " to go before the knockout bracket unlocks.");
    } else {
      lines.push("<b>The draft is locked.</b> Every team has its 2 countries — now the bracket decides who climbs.");
    }

    lines.push("All " + ctx.teams.length + " teams sit level at <b>zero</b> — " +
      ctx.fixtures.length + " knockout " + plural(ctx.fixtures.length, "match", "matches") +
      " to decide the standings.");

    lines.push("Scoring runs on advancement: <b>R32 = 3</b>, R16 = 5, QF = 8, SF = 13, <b>Final = 21</b>, " +
      "plus a goal bonus. Most points takes top spot.");

    var mine = null;
    ctx.teams.forEach(function (t) { if (t.isMine) mine = t; });
    if (mine) {
      var ids = ctx.draft.countriesByTeam[mine.abbr] || [];
      var picked = ids.map(function (id) {
        var c = ctx.helpers.countryById(id);
        return c ? c.flag + " " + esc(c.name) : null;
      }).filter(Boolean);
      if (picked.length) {
        lines.push("⭐ <b>" + esc(mine.name) + "</b> watch: drafted " + picked.join(" and ") +
          " — both chasing a deep bracket run.");
      } else {
        lines.push("⭐ <b>" + esc(mine.name) + "</b> is still on the clock — no countries drafted yet.");
      }
    }

    return lines;
  }

  function headlinesHtml(ctx) {
    var lines = (ctx.started ? liveLines(ctx) : preseasonLines(ctx)).slice(0, 5);
    // Stash the plain-text headlines so the copy button can flatten them.
    lastWire = lines.map(stripTags);
    var items = lines.map(function (line) { return '<li class="st-line">' + line + "</li>"; }).join("");
    return '<section class="st-block">' +
      '<div class="st-head">📡 Wire Report</div>' +
      '<div class="st-headlines"><ul class="st-lines">' + items + "</ul></div>" +
      '<div class="st-wire-actions">' +
        '<button type="button" class="st-wire-copy" data-st-action="copy-wire" ' +
          'aria-label="Copy today\'s wire report to your clipboard">📋 Copy today\'s wire</button>' +
      "</div>" +
      "</section>";
  }

  /* Flatten the current headlines into a dated plain-text digest. */
  function wireDigest() {
    var lines = lastWire || [];
    var date = new Date();
    var stamp = date.getFullYear() + "-" +
      ("0" + (date.getMonth() + 1)).slice(-2) + "-" +
      ("0" + date.getDate()).slice(-2);
    var out = ["📡 Wire Report — " + stamp];
    lines.forEach(function (line) { if (line) out.push("• " + line); });
    out.push("");
    out.push(SITE_URL);
    return out.join("\n");
  }

  /* Single delegated listener — the host is rebuilt every render, so we bind
     once at module load rather than per render. */
  function onWireClick(e) {
    var btn = e.target.closest ? e.target.closest("[data-st-action='copy-wire']") : null;
    if (!btn) return;
    writeClipboard(wireDigest()).then(function () {
      if (btn.getAttribute("data-flashing")) return;
      btn.setAttribute("data-flashing", "1");
      var original = btn.textContent;
      btn.textContent = "Copied ✓";
      btn.classList.add("is-copied");
      setTimeout(function () {
        btn.textContent = original;
        btn.classList.remove("is-copied");
        btn.removeAttribute("data-flashing");
      }, 1600);
    }).catch(function () {});
  }

  /* ---------------- record book ---------------- */

  function cardHtml(label, value, detail, dim) {
    return '<div class="st-card">' +
      '<div class="st-card-label">' + label + "</div>" +
      '<div class="st-card-value' + (dim ? " dim" : "") + '">' + value + "</div>" +
      '<div class="st-card-detail">' + detail + "</div>" +
      "</div>";
  }

  /* Furthest round any country has reached, and how many sit there. */
  function furthestRoundCard(ctx) {
    var esc = ctx.helpers.esc;
    var ROUND_ORD = { "R32": 1, "R16": 2, "QF": 3, "SF": 4, "Final": 5, "Champion": 6 };
    var bestOrd = 0;
    var bestKey = null;
    var count = 0;
    // Derive each country's furthest round from the bracket itself.
    var reachedOf = countryReached(ctx);
    Object.keys(reachedOf).forEach(function (id) {
      var key = reachedOf[id];
      var ord = ROUND_ORD[key] || 0;
      if (ord <= 0) return;
      if (ord > bestOrd) { bestOrd = ord; bestKey = key; count = 1; }
      else if (ord === bestOrd) count += 1;
    });
    if (!bestKey) return cardHtml("Furthest round", "&mdash;", ctx.started ? "no results yet" : WAIT, true);
    var label = bestKey === "Champion" ? "🏆 Champion" : esc(ctx.helpers.roundLabel(bestKey));
    return cardHtml("Furthest round", label,
      count + " " + plural(count, "country", "countries") + " " +
      (bestKey === "Champion" ? "crowned" : "this deep"));
  }

  function topCountryCard(ctx) {
    var esc = ctx.helpers.esc;
    var best = null;
    ctx.field.list.forEach(function (c) {
      if (!best || c.goals > best.goals) best = { country: c, goals: c.goals };
    });
    if (!best || best.goals === 0) return cardHtml("Top scorer", "&mdash;", WAIT, true);
    var abbr = ctx.helpers.countryTeamOwner(best.country.id);
    var owner = abbr ? teamByAbbr(ctx, abbr) : null;
    return cardHtml("Top scorer", best.goals,
      best.country.flag + " " + esc(best.country.name) + " · " +
      (owner ? esc(owner.name) : "undrafted"));
  }

  /* How many fantasy teams still have at least one country alive. */
  function mostTeamsAdvancedCard(ctx) {
    var alive = 0;
    ctx.standings.forEach(function (row) { if (row.aliveCount > 0) alive += 1; });
    if (!ctx.started) return cardHtml("Teams advancing", "&mdash;", WAIT, true);
    return cardHtml("Teams advancing", alive,
      "of " + ctx.teams.length + " still have a country alive", alive === 0);
  }

  function biggestMatchCard(ctx) {
    var esc = ctx.helpers.esc;
    var best = null;
    allMatches(ctx).forEach(function (fx) {
      if (!isCounted(fx) || !hasScore(fx)) return;
      var total = fx.homeGoals + fx.awayGoals;
      if (!best || total > best.total) best = { fx: fx, total: total };
    });
    if (!best) return cardHtml("Highest-scoring match", "&mdash;", WAIT, true);
    var fx = best.fx;
    return cardHtml("Highest-scoring match", best.total,
      fx.home.flag + " " + esc(fx.home.name) + " " + fx.homeGoals + "–" + fx.awayGoals +
      " " + esc(fx.away.name) + " " + fx.away.flag);
  }

  function totalGoalsCard(ctx) {
    var ms = allMatches(ctx);
    var total = ms.reduce(function (sum, fx) {
      if (!isCounted(fx) || !hasScore(fx)) return sum;
      return sum + fx.homeGoals + fx.awayGoals;
    }, 0);
    var played = ms.filter(isFinished).length;
    return cardHtml("Total goals", total,
      played + " of " + ms.length + " matches played", total === 0);
  }

  function goalsPerMatchCard(ctx) {
    var count = 0;
    var sum = 0;
    allMatches(ctx).forEach(function (fx) {
      if (!isCounted(fx) || !hasScore(fx)) return;
      count += 1;
      sum += fx.homeGoals + fx.awayGoals;
    });
    if (count === 0) return cardHtml("Goals per match", "&mdash;", WAIT, true);
    return cardHtml("Goals per match", (sum / count).toFixed(1),
      "across " + count + " " + plural(count, "match", "matches") + " with a result");
  }

  /* Biggest margin and clean sheets read finished games only — an in-play
     scoreline can still swing, so we don't want to crown a live blowout or
     award a shutout to a match that isn't over. */
  function biggestMarginCard(ctx) {
    var esc = ctx.helpers.esc;
    var best = null;
    allMatches(ctx).forEach(function (fx) {
      if (!isFinished(fx) || !hasScore(fx)) return;
      var margin = Math.abs(fx.homeGoals - fx.awayGoals);
      if (margin <= 0) return;
      if (!best || margin > best.margin) best = { fx: fx, margin: margin };
    });
    if (!best) return cardHtml("Biggest margin", "&mdash;", ctx.started ? "no decisive results yet" : WAIT, true);
    var fx = best.fx;
    return cardHtml("Biggest margin", best.margin,
      fx.home.flag + " " + esc(fx.home.name) + " " + fx.homeGoals + "–" + fx.awayGoals +
      " " + esc(fx.away.name) + " " + fx.away.flag);
  }

  function cleanSheetsCard(ctx) {
    var played = 0, shutouts = 0;
    allMatches(ctx).forEach(function (fx) {
      if (!isFinished(fx) || !hasScore(fx)) return;
      played += 1;
      if (fx.homeGoals === 0 || fx.awayGoals === 0) shutouts += 1;
    });
    if (played === 0) return cardHtml("Clean sheets", "&mdash;", WAIT, true);
    return cardHtml("Clean sheets", shutouts,
      "in " + played + " finished " + plural(played, "match", "matches"), shutouts === 0);
  }

  function recordsHtml(ctx) {
    var cards = [
      furthestRoundCard(ctx),
      topCountryCard(ctx),
      mostTeamsAdvancedCard(ctx),
      biggestMatchCard(ctx),
      biggestMarginCard(ctx),
      cleanSheetsCard(ctx),
      totalGoalsCard(ctx),
      goalsPerMatchCard(ctx)
    ].join("");
    return '<section class="st-block">' +
      '<div class="st-head">📜 Record Book</div>' +
      '<div class="st-cards">' + cards + "</div>" +
      "</section>";
  }

  /* ---------------- bracket-derived country status ---------------- */

  /* For each countryId, the furthest round key it reached
     ("R32".."Final"|"Champion"), or "—" if it never appeared. */
  function countryReached(ctx) {
    var ROUNDS = ctx.bracket.rounds || [];
    var reachedOrd = {};
    ROUNDS.forEach(function (round) {
      round.matches.forEach(function (mt) {
        [mt.home, mt.away].forEach(function (slot) {
          var cid = slot && slot.countryId;
          if (!cid) return;
          if (!reachedOrd[cid] || round.ordinal > reachedOrd[cid]) {
            reachedOrd[cid] = round.ordinal;
          }
        });
      });
    });
    // Champion = winner of the Final round's single match.
    var championId = null;
    var finalRound = ROUNDS[ROUNDS.length - 1];
    if (finalRound && finalRound.matches[0] && finalRound.matches[0].winnerId) {
      championId = finalRound.matches[0].winnerId;
    }
    var out = {};
    Object.keys(reachedOrd).forEach(function (cid) {
      if (championId && cid === championId) { out[cid] = "Champion"; return; }
      var meta = ROUNDS[reachedOrd[cid] - 1];
      out[cid] = meta ? meta.name : "—";
    });
    return out;
  }

  /* Per-country, per-round segment state for the roster bars:
     "won"   — country advanced out of this round (won its match)
     "alive" — country is in this round and not yet eliminated (playing / TBD)
     "out"   — country lost here, or never reached this round. */
  function countrySegments(ctx, countryId) {
    var ROUNDS = ctx.bracket.rounds || [];
    return ROUNDS.map(function (round) {
      var mt = null;
      round.matches.forEach(function (m) {
        if ((m.home && m.home.countryId === countryId) ||
            (m.away && m.away.countryId === countryId)) mt = m;
      });
      if (!mt) return "out"; // never reached this round
      if (mt.winnerId === countryId) return "won";
      if (mt.winnerId) return "out"; // a decided match this country did not win
      return "alive"; // present, undecided (scheduled or in play)
    });
  }

  /* ---------------- draft roster (was group runway) ---------------- */

  function rosterRow(ctx, row) {
    var esc = ctx.helpers.esc;
    var ROUND_ORD = { "R32": 1, "R16": 2, "QF": 3, "SF": 4, "Final": 5, "Champion": 6 };

    // One bar per drafted country (each team has up to 2). Each bar is the
    // 5-round bracket path for that country.
    var bars = (row.drafted || []).map(function (country) {
      var segs = countrySegments(ctx, country.id).map(function (state) {
        return '<span class="st-seg ' + state + '"></span>';
      }).join("");
      return '<span class="st-roster-country">' +
        '<span class="st-roster-flag">' + country.flag + "</span>" +
        '<span class="st-segs">' + segs + "</span>" +
        "</span>";
    }).join("");
    if (!bars) bars = '<span class="st-roster-empty">no countries drafted</span>';

    var accent = esc(row.team.accent || "#c89638");
    var deep = row.reached && row.reached !== "—"
      ? (row.reached === "Champion" ? "🏆 Champion" : esc(ctx.helpers.roundLabel(row.reached)))
      : "—";
    return '<div class="st-run' + (row.team.isMine ? " mine" : "") + '" style="--st-ac:' + accent + '">' +
      '<span class="st-run-name">' + esc(row.team.name) + (row.team.isMine ? " ⭐" : "") + "</span>" +
      '<span class="st-chip">' + deep + "</span>" +
      '<span class="st-roster-bars">' + bars + "</span>" +
      '<span class="st-run-goals">' + row.points + " " + plural(row.points, "pt", "pts") + "</span>" +
      "</div>";
  }

  function rosterHtml(ctx) {
    var rows = ctx.standings.map(function (row) { return rosterRow(ctx, row); }).join("");
    return '<section class="st-block">' +
      '<div class="st-head">🏆 Draft Roster</div>' +
      '<div class="st-runway">' + rows +
        '<p class="st-foot">Each team’s 2 drafted countries through R32 → Final — ' +
        'gold = advanced, pulsing = still alive, dim = out.</p>' +
      "</div></section>";
  }

  /* ---------------- golden boot (top scoring nations) ---------------- */

  /* Every country that's found the net, most goals first, name as a stable
     tiebreaker so the board doesn't reshuffle between equal-goal nations. */
  function scoringNations(ctx) {
    var rows = [];
    ctx.field.list.forEach(function (c) {
      if (c.goals > 0) rows.push({ country: c, draftedBy: ctx.helpers.countryTeamOwner(c.id) });
    });
    return rows.sort(function (a, b) {
      if (b.country.goals !== a.country.goals) return b.country.goals - a.country.goals;
      return a.country.name.localeCompare(b.country.name);
    });
  }

  var BOOT_MAX = 8; // keep the board glanceable; the long tail lives in the Bracket

  function bootRow(ctx, entry, rank, max) {
    var esc = ctx.helpers.esc;
    var c = entry.country;
    var owner = entry.draftedBy ? teamByAbbr(ctx, entry.draftedBy) : null;
    var pct = Math.max(Math.round((c.goals / max) * 100), 6);
    var ownerTag = owner
      ? '<span class="st-lead-owner' + (owner.isMine ? " mine" : "") +
        '" style="--st-ac:' + (owner.accent || "#c89638") + '">' + esc(owner.abbr) + (owner.isMine ? " ⭐" : "") + "</span>"
      : '<span class="st-lead-owner empty">undrafted</span>';
    return '<div class="st-lead' + (owner && owner.isMine ? " mine" : "") + (rank === 1 ? " lead" : "") + '">' +
      '<div class="st-lead-main">' +
        '<span class="st-lead-rank">' + rank + "</span>" +
        '<span class="st-lead-flag">' + c.flag + "</span>" +
        '<span class="st-lead-name">' + esc(c.name) + "</span>" +
        ownerTag +
      "</div>" +
      '<div class="st-lead-track"><div class="st-lead-fill" style="width:' + pct + '%"></div></div>' +
      '<span class="st-lead-goals">' + c.goals + "</span>" +
      "</div>";
  }

  function goldenBootHtml(ctx) {
    var nations = scoringNations(ctx);
    var body, foot;
    if (!nations.length) {
      body = '<p class="st-empty">' +
        (ctx.started ? "No goals on the board yet — the Golden Boot race is goalless."
                     : "The race for the Golden Boot opens at first whistle.") + "</p>";
      foot = "";
    } else {
      var max = nations[0].country.goals;
      var top = nations.slice(0, BOOT_MAX);
      body = top.map(function (entry, i) { return bootRow(ctx, entry, i + 1, max); }).join("");
      foot = '<p class="st-foot">' + (nations.length > top.length
        ? "Top " + top.length + " of " + nations.length + " nations on the scoresheet — and the team that drafted each one."
        : "Every nation that's found the net — and the team that drafted each one.") + "</p>";
    }
    return '<section class="st-block">' +
      '<div class="st-head">🥇 Golden Boot · Top Scoring Nations</div>' +
      '<div class="st-lead-wrap">' + body + foot + "</div>" +
      "</section>";
  }

  /* ---------------- goals by round ---------------- */

  function roundsHtml(ctx) {
    var rounds = ctx.bracket.rounds || [];
    var totals = rounds.map(function (round) {
      return round.matches.reduce(function (sum, mt) {
        if (!isCounted(mt) || !hasScore(mt)) return sum;
        return sum + mt.homeGoals + mt.awayGoals;
      }, 0);
    });
    var max = totals.reduce(function (m, t) { return t > m ? t : m; }, 0);
    var rows = rounds.map(function (round, i) {
      var t = totals[i];
      var pct = max > 0 ? Math.max(Math.round((t / max) * 100), 3) : 3;
      return '<div class="st-md-row">' +
        '<span class="st-md-label">' + ctx.helpers.esc(round.name) + "</span>" +
        '<div class="st-md-track"><div class="st-md-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="st-md-count">' + t + "</span>" +
        "</div>";
    }).join("");
    return '<section class="st-block">' +
      '<div class="st-head">⚽ Goals by Round</div>' +
      '<div class="st-md">' + rows +
        '<p class="st-foot">Total goals scored across the knockout bracket, round by round.</p>' +
      "</div></section>";
  }

  /* ---------------- render ---------------- */

  function render(ctx) {
    if (!ctx || !ctx.standings || !ctx.bracket || !ctx.draft) return;
    var host = document.getElementById("stats-host");
    if (!host) return;
    host.innerHTML = '<div class="st-wrap">' +
      headlinesHtml(ctx) +
      recordsHtml(ctx) +
      goldenBootHtml(ctx) +
      rosterHtml(ctx) +
      roundsHtml(ctx) +
      "</div>";
  }

  document.addEventListener("click", onWireClick);
  if (window.Hub) Hub.onRender(render);
})();
