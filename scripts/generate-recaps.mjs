#!/usr/bin/env node
/* ============================================================
   Generates data/recaps.json — one AI-written recap per FINISHED
   group-stage match, with the goal-by-goal scorer list.

   Source: the SAME FIFA timeline API the card-tracker already
   uses (api.fifa.com, tokenless). Goal events are read straight
   from the timeline:
     Type 0  = goal           "Julian QUINONES (Mexico) scores!!"
     Type 34 = own goal       "Damian BOBADILLA (Paraguay) scores
                               an own goal!!"  (counts for the OTHER team)
     Type 3  = red card        (kept for narrative colour)
   Minute format is "9'", "45'+5'", "90'+8'".

   The prose summary is written by a free GitHub Models LLM when a
   token is available (richer, true "AI description"); otherwise a
   clean built-in writer assembles a solid recap from the same facts,
   so the feature works with zero configuration. Already-recapped matches
   are cached and never re-sent to the model unless their score or
   goals changed — keeps the cron cheap and the text stable.

   Never hard-fails: on any error it exits 0, leaving the previous
   data/recaps.json in place.
   ============================================================ */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = `${ROOT}/data/recaps.json`;

/* ---------------- FIFA (tokenless) ---------------- */

const FIFA_BASE = "https://api.fifa.com/api/v3";
const COMP = "17"; // FIFA World Cup
const SEASON = "285023"; // FIFA World Cup 2026

const EVENT_GOAL = 0;
const EVENT_RED = 3;
const EVENT_OWN_GOAL = 34;

/* ---------------- prose providers (optional, all free) ----------------
   Free, OpenAI-compatible LLM endpoints, tried in order — the first that
   returns text wins; if all are absent or fail, the built-in writer takes
   over. NOTE: recaps are generated server-side ~once per finished match
   (then cached), NOT per visitor, so site traffic never drives token use.

   1. NVIDIA NIM   — set NVIDIA_API_KEY (nvapi-…); huge free allowance,
                     reuses the key from the generate-image setup.
   2. GitHub Models — the workflow's built-in GITHUB_TOKEN works once the
                     job grants `permissions: models: read` (no secret). */

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
const NIM_MODEL = process.env.NIM_MODEL || "meta/llama-3.3-70b-instruct";

const GH_MODELS_TOKEN = process.env.GH_MODELS_TOKEN || process.env.GITHUB_TOKEN || "";
const GH_MODEL = process.env.GH_MODEL || "openai/gpt-4o-mini";

const AI_ENABLED = !!NVIDIA_API_KEY || !!GH_MODELS_TOKEN;

/* ---------------- helpers ---------------- */

function loc(arr) {
  return (Array.isArray(arr) && arr[0] && arr[0].Description) || null;
}

function groupLetter(m) {
  const g = loc(m.GroupName) || "";
  const hit = g.match(/^Group ([A-L])$/);
  return hit ? hit[1] : null;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/* The FIFA feed uses a few names the hub spells differently. Emit the hub's
   spelling so recaps read consistently with the rest of the site (the
   front-end's Live.resolveCountry maps either way, but baking it in keeps the
   AI/template summary text consistent too). */
const NAME_MAP = {
  "Korea Republic": "South Korea",
  "Czechia": "Czech Republic",
  "USA": "United States",
  "Bosnia and Herzegovina": "Bosnia & Herzegovina",
  "IR Iran": "Iran",
  "Côte d'Ivoire": "Ivory Coast",
  "Cote d'Ivoire": "Ivory Coast",
  "Congo DR": "DR Congo",
  "Cabo Verde": "Cape Verde"
};

function disp(name) {
  return NAME_MAP[name] || name;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z]+/g, " ")
    .trim();
}

/* FIFA names are "Julian QUINONES" / "RAÚL" / "HWANG Inbeom" — tidy the
   ALL-CAPS surnames into Title Case while leaving already-cased given
   names alone. Accents survive (toLowerCase maps Ú → ú). */
function tidyName(raw) {
  return String(raw || "")
    .trim()
    .split(/\s+/)
    .map((w) => {
      if (w.length > 1 && w === w.toUpperCase()) {
        return w.charAt(0) + w.slice(1).toLowerCase();
      }
      return w;
    })
    .join(" ");
}

/* "45'+5'" -> 45.05, "90'+8'" -> 90.08, "9'" -> 9 — a sortable minute. */
function minuteOrder(min) {
  const m = String(min || "").match(/(\d+)(?:'?\s*\+\s*(\d+))?/);
  if (!m) return 999;
  const base = parseInt(m[1], 10);
  const extra = m[2] ? parseInt(m[2], 10) : 0;
  return base + extra / 100;
}

/* Parse one goal/own-goal timeline event into {player, scoredForTeam}. */
function parseGoalEvent(ev) {
  const desc = loc(ev.EventDescription) || "";
  const m = desc.match(/^(.+?)\s*\((.+?)\)\s*scores/i);
  if (!m) return null;
  const ownGoal = ev.Type === EVENT_OWN_GOAL || /own goal/i.test(desc);
  const penalty = /penalt/i.test(desc);
  return {
    player: tidyName(m[1]),
    playerTeam: m[2].trim(), // the player's OWN team (FIFA name)
    minute: ev.MatchMinute || "",
    order: minuteOrder(ev.MatchMinute),
    ownGoal,
    penalty
  };
}

/* Build the structured goal list for a match, in chronological order. */
function buildGoals(events, homeName, awayName) {
  const goalish = events.filter(
    (e) => e.Type === EVENT_GOAL || e.Type === EVENT_OWN_GOAL
  );
  const goals = goalish
    .map((ev) => {
      const g = parseGoalEvent(ev);
      if (!g) return null;
      const scoredByHome = norm(g.playerTeam) === norm(homeName);
      // An own goal counts for the OTHER team.
      const side = g.ownGoal
        ? scoredByHome
          ? "away"
          : "home"
        : scoredByHome
          ? "home"
          : "away";
      return {
        minute: g.minute,
        order: g.order,
        player: g.player,
        // Match against the raw feed names above, but emit the hub's spelling.
        team: disp(side === "home" ? homeName : awayName),
        side,
        ownGoal: g.ownGoal,
        penalty: g.penalty
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
  return goals;
}

function redCardLines(events) {
  return events
    .filter((e) => e.Type === EVENT_RED)
    .map((e) => loc(e.EventDescription))
    .filter(Boolean);
}

/* ---------------- prose: built-in writer (no key needed) ---------------- */

function scorerPhrase(g) {
  const tags = [];
  if (g.ownGoal) tags.push("o.g.");
  if (g.penalty) tags.push("pen");
  const tag = tags.length ? " " + tags.join(", ") : "";
  return `${g.player} (${g.minute}${tag})`;
}

function templateHeadline(r) {
  if (r.homeGoals === r.awayGoals) {
    return `${r.home} and ${r.away} share the points`;
  }
  const winner = r.homeGoals > r.awayGoals ? r.home : r.away;
  const loser = r.homeGoals > r.awayGoals ? r.away : r.home;
  return `${winner} see off ${loser}`;
}

function templateSummary(r) {
  const score = `${r.homeGoals}–${r.awayGoals}`;
  let lead;
  if (r.homeGoals === r.awayGoals) {
    lead = `${r.home} and ${r.away} played out a ${score} draw in Group ${r.group}.`;
  } else {
    const winner = r.homeGoals > r.awayGoals ? r.home : r.away;
    const loser = r.homeGoals > r.awayGoals ? r.away : r.home;
    lead = `${winner} beat ${loser} ${score} in Group ${r.group}.`;
  }
  if (!r.goals.length) return lead;
  const scorers = r.goals.map(scorerPhrase).join(", ");
  let tail = ` Goals: ${scorers}.`;
  if (r.reds && r.reds.length) {
    tail += ` ${r.reds.length === 1 ? "A red card" : r.reds.length + " red cards"} added to the drama.`;
  }
  return lead + tail;
}

/* ---------------- prose: free LLM providers (optional) ---------------- */

/* The chat messages handed to every provider (they're all OpenAI-shaped). */
function buildMessages(r) {
  const facts =
    `Match: ${r.home} ${r.homeGoals}-${r.awayGoals} ${r.away} (Group ${r.group}` +
    (r.venue ? `, ${r.venue}` : "") +
    `).\nGoals in order: ` +
    (r.goals.length
      ? r.goals
          .map(
            (g) =>
              `${g.player} ${g.minute} for ${g.team}` +
              (g.ownGoal ? " (own goal)" : g.penalty ? " (penalty)" : "")
          )
          .join("; ")
      : "none") +
    (r.reds && r.reds.length ? `\nRed cards: ${r.reds.join("; ")}` : "");

  const prompt =
    `You are writing a punchy recap for a 2026 World Cup match on a fantasy-league hub. ` +
    `Use only these facts, present tense, no markdown, 2-3 sentences (max ~60 words). ` +
    `Name the key scorers and the result; energetic but factual.\n\n${facts}`;

  return [
    { role: "system", content: "You write concise, factual football match recaps." },
    { role: "user", content: prompt }
  ];
}

/* Shared OpenAI-style chat POST. Returns trimmed text or null (never throws). */
async function chatComplete(label, url, headers, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      console.error(`${label} ${res.status} ${res.statusText} — trying next provider.`);
      return null;
    }
    const data = await res.json();
    const text =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      String(data.choices[0].message.content || "").trim();
    return text || null;
  } catch (err) {
    console.error(`${label} request failed — trying next provider: ${err.message}`);
    return null;
  }
}

function nvidiaNim(messages) {
  if (!NVIDIA_API_KEY) return Promise.resolve(null);
  return chatComplete(
    "NVIDIA NIM",
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    { model: NIM_MODEL, max_tokens: 200, temperature: 0.7, messages }
  );
}

function githubModels(messages) {
  if (!GH_MODELS_TOKEN) return Promise.resolve(null);
  return chatComplete(
    "GitHub Models",
    "https://models.github.ai/inference/chat/completions",
    {
      Authorization: `Bearer ${GH_MODELS_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10"
    },
    { model: GH_MODEL, max_tokens: 200, temperature: 0.7, messages }
  );
}

/* Tried in order; NVIDIA NIM first (biggest free allowance), GitHub Models
   as the no-secret fallback. */
const PROVIDERS = [
  { name: "NVIDIA NIM", on: () => !!NVIDIA_API_KEY, run: nvidiaNim },
  { name: "GitHub Models", on: () => !!GH_MODELS_TOKEN, run: githubModels }
];

/* Returns { text, via } from the first provider that answers, or null. */
async function aiSummary(r) {
  const messages = buildMessages(r);
  for (const p of PROVIDERS) {
    if (!p.on()) continue;
    const text = await p.run(messages);
    if (text) return { text, via: p.name };
  }
  return null;
}

/* ---------------- main ---------------- */

/* A fingerprint of the scoreline + goals; if unchanged we keep the cached
   recap (and never re-call the model). */
function fingerprint(r) {
  return JSON.stringify([
    r.home,
    r.away,
    r.homeGoals,
    r.awayGoals,
    r.goals.map((g) => [g.minute, g.player, g.team, g.side, g.ownGoal, g.penalty])
  ]);
}

async function main() {
  let prev = null;
  try {
    prev = JSON.parse(await readFile(OUT, "utf8"));
  } catch (_) {}
  const prevById = (prev && prev.byId) || {};

  let cal;
  try {
    cal = await fetchJson(
      `${FIFA_BASE}/calendar/matches?idCompetition=${COMP}&idSeason=${SEASON}&count=200&language=en`
    );
  } catch (err) {
    console.error("FIFA calendar fetch failed:", err.message);
    return; // leave existing recaps in place
  }

  const finished = (cal.Results || []).filter(
    (m) => m.MatchStatus === 0 && groupLetter(m)
  );
  console.log(`${finished.length} finished group-stage matches.`);

  const byId = {};
  let aiCount = 0;
  let reusedCount = 0;

  for (const m of finished) {
    const id = String(m.IdMatch);
    const home = loc(m.Home && m.Home.TeamName) || "TBD";
    const away = loc(m.Away && m.Away.TeamName) || "TBD";

    let events = [];
    try {
      const tl = await fetchJson(
        `${FIFA_BASE}/timelines/${COMP}/${SEASON}/${m.IdStage}/${m.IdMatch}?language=en`
      );
      events = Array.isArray(tl.Event) ? tl.Event : [];
    } catch (err) {
      console.error(`Timeline failed for ${home} v ${away}: ${err.message}`);
      // Reuse the previous recap for this match if we have one.
      if (prevById[id]) {
        byId[id] = prevById[id];
        reusedCount += 1;
      }
      continue;
    }

    const recap = {
      id,
      group: groupLetter(m),
      home: disp(home),
      away: disp(away),
      homeGoals: m.HomeTeamScore == null ? 0 : m.HomeTeamScore,
      awayGoals: m.AwayTeamScore == null ? 0 : m.AwayTeamScore,
      venue: loc(m.Stadium && m.Stadium.Name),
      utcDate: m.Date || null,
      goals: buildGoals(events, home, away),
      reds: redCardLines(events)
    };
    recap.headline = templateHeadline(recap);

    const fp = fingerprint(recap);
    const cached = prevById[id];
    // Reuse cached prose when nothing changed — but if we now have a model
    // token and the cached text was only the built-in writer, upgrade it.
    const canReuse =
      cached &&
      cached.fingerprint === fp &&
      cached.summary &&
      (cached.ai || !AI_ENABLED);
    if (canReuse) {
      recap.summary = cached.summary;
      recap.ai = !!cached.ai;
      recap.aiVia = cached.aiVia || null;
      reusedCount += 1;
    } else {
      const ai = await aiSummary(recap);
      recap.summary = ai ? ai.text : templateSummary(recap);
      recap.ai = !!ai;
      recap.aiVia = ai ? ai.via : null;
      if (ai) aiCount += 1;
    }
    recap.fingerprint = fp;
    byId[id] = recap;
  }

  const payload = {
    competition: "FWC2026",
    generatedAt: new Date().toISOString(),
    count: Object.keys(byId).length,
    byId
  };

  // Skip writing when nothing of substance changed (keeps git history clean;
  // generatedAt alone is ignored).
  if (prev && stableEqual(prev.byId, byId)) {
    console.log(`No recap changes (${payload.count} matches). Nothing to write.`);
    return;
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
  const providers =
    [NVIDIA_API_KEY && "NVIDIA NIM", GH_MODELS_TOKEN && "GitHub Models"]
      .filter(Boolean)
      .join(" → ");
  console.log(
    `Wrote ${payload.count} recaps (${aiCount} newly AI-written, ${reusedCount} reused, ` +
      `${AI_ENABLED ? "providers: " + providers : "built-in writer"}).`
  );
}

/* Deep-equal on the recap maps, ignoring volatile top-level timestamps. */
function stableEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exitCode = 0; // never break the cron on a bad run
});
