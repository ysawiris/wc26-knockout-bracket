# WC26 Knockout Pool · The Longest Yard

A one-page hub for a 12-team World Cup **knockout** fantasy pool. Each team
snake-drafts **two** of the 32 Round-of-32 countries; you score by how far your
countries advance, and the live standings become the league's draft order.

Ported from the group-stage [wc26-draft-tracker](../wc26-draft-tracker) hub (same
gold/black broadcast look, same `window.Hub` architecture), retuned end-to-end for
the knockout. Plain HTML/CSS/JS, no build step.

## The flow

1. **Draft Order** — the 12 teams in last-season finish order. Reorder, or flip
   best-first / worst-first. This seeds the snake.
2. **Snake Draft** — go on the clock and draft 2 of the 32 R32 countries (24 picks).
   Auto-pick, auto-fill, undo, reset. **The hub stays locked until all 24 picks are in.**
3. Once the draft completes, the **Draft Order + Snake Draft tabs are retired** and
   replaced by a single **Draft Recap** (each team's two picks + the full pick-by-pick
   snake). The rest of the hub unlocks.
4. **Bracket** — R32 → R16 → QF → SF → Final. Tap a side to advance it; optional goal
   inputs feed each owner's goal bonus.
5. **Standings** — live order by points, 👑 on the leader, rank-movement arrows, your
   team highlighted; Copy / WhatsApp / Share-card.
6. **Forecast** — your personal **Road to your pick** + a Monte-Carlo advancement
   forecast (No.1 favorite, your projected finish, the probability matrix).
7. **Stats** — the **Race** bump chart (rank by round), the Wire Report, the Record Book.
8. **Rules** — how it all works.

Plus: the live/next-up strip with a countdown, pick-your-team (`?team=ABBR` deep
links + per-device highlight), goal alerts, and a responsive top + bottom nav.

## Scoring

A team's points = advancement of its **two drafted countries** through the bracket —
**R32 = 3 · R16 = 5 · QF = 8 · SF = 13 · Final = 21** — plus **0.1 per goal** they score.
Most points takes the No. 1 draft slot. Ties break on advancement points, then draft
slot. Cards and fouls are shown in match detail but **never** score.

Config lives in `js/data.js` (`POINTS_CONFIG`, `GOAL_BONUS_PER_GOAL`).

## Layout

```
index.html        # tabbed hub shell (top + bottom nav)
js/data.js        # 12 teams, 32 R32 countries (FIELD), bracket seeding, scoring config
js/store.js       # localStorage state (wc26ko.v4) + derived selectors (draft, bracket, standings)
js/app.js         # orchestrator: ctx + Hub API, draft gate, Draft Order / Snake Draft / Recap / Bracket / Standings
js/my-team.js     # per-viewer team identity (picker, ?team=, highlight)
js/schedule.js    # buildKnockoutFixtures — flattens the bracket into fixtures
js/live.js        # dormant live layer (manual entry for v1; INPLAY/FINISHED status + calendar helpers)
js/{road,odds,stats,race,simulator,board-extras,alerts,share-card,matchcenter,recaps,xg}.js
                  # feature modules — each registers Hub.onRender(ctx) and renders one tab/widget
sw.js             # PWA service worker (auto-disabled on localhost — see below)
```

State is `localStorage` (key `wc26ko.v4`). The draft, bracket results and rules all
persist on the device; the standings/odds/race/road are all derived from them.

## Run it

```
cd wc26-knockout-bracket
python3 -m http.server 5212
# open http://localhost:5212
```

## Going live — swap-in checklist (when the group stage ends, ~Jun 27)

Everything below is a single-file edit to `js/data.js`; no logic code changes.
The same list lives as a comment at the top of that file.

1. **FIELD** — replace the 32 placeholder countries with the **real qualifiers**.
   Keep each `seed` a unique `1..32` (it drives both bracket position and the
   strong/weak draft split) and each `id` unique. Match the `GROUPS` spellings so
   recaps/alias matching stays consistent.
2. **R32_PAIRINGS** — set the 16 **actual drawn** matchups as `[homeId, awayId]`
   in bracket order `r32-1 … r32-16`. Leave it `null` to use the seed serpentine
   (1v32, 2v31, …). ⚠️ A malformed array silently falls back to the serpentine —
   confirm 16 pairs and that every id exists in `FIELD`.
3. **Draft order** — `TEAMS` is listed in the order the snake starts from. Reorder
   `TEAMS`, or set it in-app on the Draft Order tab (persists per device).
4. **`js/xg.js` RATINGS** — confirm every `FIELD` name has an Elo entry (unmatched
   names fall back to 1700; real ratings sharpen the Forecast).
5. **`LEAGUE.lastUpdated`** — bump the date; **`LEAGUE.commishAbbr`** — set to the
   commissioner's team (powers the 👑 badge in the team picker).
6. **Deploy** — bump `VERSION` in `sw.js` and push (Pages redeploys ~1 min).

## Commissioner workflow (sharing one bracket with the league)

Results are entered by hand for v1, on one device. To publish them so every
member sees the same bracket:

1. On the **Bracket** tab, tap **⬇ Export for the league** — it copies a full
   JSON snapshot (draft order + picks + results) to your clipboard.
2. Open **`data/results.json`** in an editor and **replace the entire file**
   with the copied JSON (paste over everything — don't merge).
3. Save, commit, push. Pages redeploys; each member's device loads it on next
   visit (the newest `updatedAt` always wins) and shows a brief "Updated to the
   league's latest bracket" toast.

Only one person should commit `data/results.json`. Pull before committing.

## Notes

- **Live FIFA results, with manual override.** A cron (`update-scores`) pulls the real
  knockout scores into `data/live.json` every ~10 min; the app overlays them onto the
  bracket and auto-advances the winner of any FINISHED match. The commissioner can still
  enter or override a result by hand on the Bracket tab (tap winners / type goals).
- **Recaps + odds feeds (tokenless).** `update-recaps` writes `data/recaps.json`
  (goal-by-goal + an AI summary, or a built-in template when no LLM key is set) and
  `update-odds` writes `data/odds.json` (ESPN over/under lines that anchor the Match
  Center win-probability magnitude). Both degrade gracefully if a feed is empty, and
  both run from free public APIs — no secrets required (add a `NVIDIA_API_KEY` repo
  secret only if you want richer AI recap prose).
- **Service worker is disabled on localhost** (`js/sw-register.js`) so edits never get
  masked by a stale cached shell. It still installs on the real domain (bump `VERSION`
  in `sw.js` on each deploy). If assets ever look stale locally: unregister the SW +
  clear caches, or use a fresh port.
