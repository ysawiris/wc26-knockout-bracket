#!/usr/bin/env node
/* ============================================================
   Generates data/scenarios.json — "what needs to happen for YOU
   to land the No. 1 pick", one entry per owned World Cup group.

   The draft order is decided by total group goals (cards break
   ties). So every owner's path to No. 1 is: (a) their four
   countries outscore the field, and (b) the rival groups don't
   run away. This script turns that into concrete, *verified*
   example scenarios — real scorelines for the owner's remaining
   matches that reach a winning total, plus the bar the chasing
   groups must stay under.

   Inputs are the data files the rest of the hub already maintains:
     data/live.json — every match's group, teams, status, score
     data/odds.json — DraftKings over/under → market expected goals
   The fixtures and current goals come straight from live.json, so
   the schedule never has to be duplicated here. Where a match has
   no posted line, an Elo-informed strength estimate fills in
   (same STRENGTH table and lambda math as js/odds.js).

   The numbers (scorelines, totals, rival caps) are COMPUTED and
   correct. A free LLM (NVIDIA NIM → GitHub Models, same provider
   chain as generate-recaps) only writes the prose framing; a
   built-in writer covers the zero-config case. Per-team prose is
   cached on a fingerprint of the inputs so the cron rarely re-calls
   the model. Never hard-fails: any error exits 0, leaving the
   previous data/scenarios.json untouched.
   ============================================================ */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LIVE = `${ROOT}/data/live.json`;
const ODDS = `${ROOT}/data/odds.json`;
const OUT = `${ROOT}/data/scenarios.json`;

/* ---------------- league wiring (the only embedded constants) ---------------- */

/* Which fantasy team owns which World Cup group. Mirrors TEAMS in js/data.js;
   Groups A and I are unclaimed and intentionally absent. */
const OWNERS = [
  { abbr: "CMC", name: "Commissioner's Infirmary 2.0", group: "G" },
  { abbr: "CDL", name: "Nicolodeons!", group: "E" },
  { abbr: "BBWC", name: "Big Blue Wrecking Crew", group: "H" },
  { abbr: "TACO", name: "Taco Corp", group: "F" },
  { abbr: "GRS", name: "Gallactic Rebel Scum", group: "D" },
  { abbr: "FF", name: "Fiko Fins", group: "L" },
  { abbr: "RBLD", name: "Another Rebuilding Year", group: "J" },
  { abbr: "TMM", name: "The Metcalf Matrix", group: "K" },
  { abbr: "AM", name: "Purdy Pitches", group: "B" },
  { abbr: "R", name: "Ms. Jackson ouuuuuuuuuuuu", group: "C" }
];

/* [att, def] expected goals scored/conceded vs an average opponent — the
   same table js/odds.js simulates from. Used only where a match has no
   posted bookmaker line. Keyed by the hub's country spelling. */
const STRENGTH = {
  Canada: [1.4, 1.1], "Bosnia & Herzegovina": [1.1, 1.3], Qatar: [0.8, 1.7], Switzerland: [1.4, 1.0],
  Brazil: [2.0, 0.8], Morocco: [1.6, 0.8], Haiti: [0.6, 2.0], Scotland: [1.1, 1.3],
  "United States": [1.5, 1.0], Paraguay: [1.1, 1.0], Australia: [1.2, 1.2], "Türkiye": [1.5, 1.3],
  Germany: [1.9, 1.0], "Curaçao": [0.7, 1.8], "Ivory Coast": [1.3, 1.1], Ecuador: [1.3, 0.9],
  Netherlands: [1.9, 0.9], Japan: [1.6, 0.9], Sweden: [1.2, 1.2], Tunisia: [0.9, 1.2],
  Belgium: [1.7, 1.1], Egypt: [1.1, 1.0], Iran: [1.2, 1.1], "New Zealand": [0.7, 1.8],
  Spain: [2.1, 0.7], "Cape Verde": [0.8, 1.5], "Saudi Arabia": [0.9, 1.5], Uruguay: [1.5, 0.9],
  France: [2.0, 0.8], Senegal: [1.4, 1.0], Iraq: [0.7, 1.7], Norway: [1.6, 1.1],
  Argentina: [2.1, 0.7], Algeria: [1.2, 1.1], Austria: [1.4, 1.1], Jordan: [0.7, 1.7],
  Portugal: [2.0, 0.8], "DR Congo": [0.9, 1.4], Uzbekistan: [0.8, 1.5], Colombia: [1.5, 0.9],
  England: [1.9, 0.8], Croatia: [1.5, 1.0], Ghana: [1.1, 1.4], Panama: [0.9, 1.5],
  Mexico: [1.4, 1.0], "South Africa": [1.0, 1.4], "South Korea": [1.3, 1.1], "Czech Republic": [1.3, 1.1]
};

const AVG_DEF = 1.25;
const FALLBACK = [1.1, 1.25];

/* The live feed spells a few countries differently — map to the hub's spelling
   so scorelines read consistently and STRENGTH lookups hit. */
const NAME_MAP = {
  "Korea Republic": "South Korea",
  Czechia: "Czech Republic",
  USA: "United States",
  "Bosnia and Herzegovina": "Bosnia & Herzegovina",
  "IR Iran": "Iran",
  "Côte d'Ivoire": "Ivory Coast",
  "Cote d'Ivoire": "Ivory Coast",
  "Congo DR": "DR Congo",
  "Cabo Verde": "Cape Verde",
  Turkey: "Türkiye",
  Curacao: "Curaçao"
};

function disp(name) {
  return NAME_MAP[name] || name;
}

function strengthOf(name) {
  return STRENGTH[disp(name)] || FALLBACK;
}

/* Expected total goals in one match (the two teams' lambdas, summed) — the
   exact matchLambda from js/odds.js. */
function matchLambda(home, away) {
  const h = strengthOf(home);
  const a = strengthOf(away);
  return h[0] * (a[1] / AVG_DEF) + a[0] * (h[1] / AVG_DEF);
}

/* ---------------- market lines (data/odds.json) ---------------- */

const MK_ALIAS = {
  bosniaandherzegovina: "bosniaherzegovina",
  cotedivoire: "ivorycoast",
  turkey: "turkiye",
  usa: "unitedstates",
  unitedstatesofamerica: "unitedstates",
  korearepublic: "southkorea",
  czechia: "czechrepublic",
  capeverdeislands: "capeverde",
  caboverde: "capeverde",
  congodr: "drcongo",
  democraticrepublicofthecongo: "drcongo"
};

function mkCanon(name) {
  const s = String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
  return MK_ALIAS[s] || s;
}

function canonPair(a, b) {
  const ca = mkCanon(a);
  const cb = mkCanon(b);
  return ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
}

const IMPLIED_MIN = 1.6;
const IMPLIED_MAX = 4.6;

/* abbrPair -> implied total, from the fetched odds payload (best-effort). */
function indexMarket(odds) {
  const byPair = {};
  if (!odds || !Array.isArray(odds.lines)) return byPair;
  for (const ln of odds.lines) {
    if (!ln || !ln.home || !ln.away) continue;
    const t = Number(ln.impliedTotal);
    if (!isFinite(t)) continue;
    byPair[canonPair(ln.home, ln.away)] = Math.min(Math.max(t, IMPLIED_MIN), IMPLIED_MAX);
  }
  return byPair;
}

/* ---------------- read the league state ---------------- */

const FIN = { FINISHED: 1, AWARDED: 1 };
const LIVE_ST = { IN_PLAY: 1, PAUSED: 1, LIVE: 1, HALFTIME: 1 };

function teamName(side) {
  return disp(side && typeof side === "object" ? side.name : side);
}

/* One row per group: banked goals, the remaining fixtures (with each one's
   expected goals), and the projected final total. */
function readGroups(live, market) {
  const groups = {};
  const ensure = (g) =>
    groups[g] || (groups[g] = { letter: g, banked: 0, played: 0, remaining: [], expRemain: 0 });

  for (const m of live.matches || []) {
    const g = m.group;
    if (!g) continue;
    const home = teamName(m.home);
    const away = teamName(m.away);
    const row = ensure(g);
    if (FIN[m.status] || LIVE_ST[m.status]) {
      row.banked += (m.homeGoals || 0) + (m.awayGoals || 0);
      row.played += 1;
    } else {
      const lambda = market[canonPair(home, away)] || matchLambda(home, away);
      row.remaining.push({ home, away, lambda, hasLine: !!market[canonPair(home, away)] });
      row.expRemain += lambda;
    }
  }
  Object.values(groups).forEach((r) => {
    r.proj = r.banked + r.expRemain;
  });
  return groups;
}

/* ---------------- scoreline construction ---------------- */

/* Spread `goals` total across the remaining matches in proportion to each
   match's expected goals, as whole numbers that sum exactly to `goals`. */
function spreadGoals(goals, matches) {
  const n = matches.length;
  if (!n) return [];
  const wsum = matches.reduce((s, m) => s + m.lambda, 0) || n;
  const raw = matches.map((m) => (goals * m.lambda) / wsum);
  const out = raw.map((x) => Math.floor(x));
  let used = out.reduce((s, x) => s + x, 0);
  /* Hand the leftover goals to the matches with the biggest rounding remainder
     (the highest-scoring fixtures absorb the extra). */
  const order = raw
    .map((x, i) => ({ i, frac: x - out[i] }))
    .sort((a, b) => b.frac - a.frac);
  let k = 0;
  while (used < goals) {
    const idx = order[k % n].i;
    if (out[idx] < 6) {
      out[idx] += 1;
      used += 1;
    }
    k += 1;
    if (k > goals + n * 7) break; /* every match capped at 6 — stop trying */
  }
  return out;
}

/* Split one match's goal count into a scoreline, leaning to the stronger
   attack with a small home edge. Never invents a 0–0 unless m is 0. */
function splitScore(match, m) {
  if (m <= 0) return { home: match.home, away: match.away, hg: 0, ag: 0 };
  const ha = strengthOf(match.home)[0];
  const aa = strengthOf(match.away)[0];
  let share = (ha + 0.15) / (ha + aa + 0.15); /* +0.15 home tilt */
  let hg = Math.round(m * share);
  let ag = m - hg;
  if (ag < 0) {
    ag = 0;
    hg = m;
  }
  return { home: match.home, away: match.away, hg, ag };
}

function linesFor(matches, totalGoals) {
  const per = spreadGoals(totalGoals, matches);
  return matches.map((mt, i) => splitScore(mt, per[i]));
}

/* ---------------- scenario building (the math) ---------------- */

function round1(x) {
  return Math.round(x * 10) / 10;
}

/* The three example paths for one owned group. Each names a winning total,
   the concrete scorelines that reach it, and the bar the chasers must stay
   under. Returns null when there's nothing left to play. */
function buildScenarios(letter, groups) {
  const me = groups[letter];
  if (!me || !me.remaining.length) return null;

  const rivals = Object.values(groups)
    .filter((g) => g.letter !== letter)
    .sort((a, b) => b.proj - a.proj);
  const winningBar = Math.round(rivals.length ? rivals[0].proj : me.proj);
  const remCount = me.remaining.length;
  const maxPlausible = me.banked + remCount * 5; /* ~5 goals/match ceiling */

  /* Targets keyed off the toughest rival projection: just-enough, comfortable,
     and a runaway that wins almost regardless of the rest of the field. */
  const raw = [
    { key: "grind", label: "Squeak in", over: 1, help: true },
    { key: "business", label: "Take care of business", over: 3, help: false },
    { key: "fest", label: "Goal-fest", over: 5, help: false }
  ];

  const scenarios = raw.map((s) => {
    let target = Math.min(winningBar + s.over, maxPlausible);
    target = Math.max(target, me.banked + remCount); /* at least ~1 goal/match */
    const need = Math.max(0, target - me.banked);
    const lines = linesFor(me.remaining, need);
    const realTotal = me.banked + lines.reduce((sum, l) => sum + l.hg + l.ag, 0);
    return {
      key: s.key,
      label: s.label,
      targetTotal: realTotal,
      yourRemainingGoals: realTotal - me.banked,
      rivalCap: realTotal - 1, /* every other group must finish at/under this */
      needsHelp: s.help,
      lines
    };
  });

  /* Drop duplicate targets (can collide near the plausible ceiling). */
  const seen = {};
  const unique = scenarios.filter((s) => {
    if (seen[s.targetTotal]) return false;
    seen[s.targetTotal] = 1;
    return true;
  });

  const ranked = Object.values(groups).sort((a, b) => b.proj - a.proj);
  const rank = ranked.findIndex((g) => g.letter === letter) + 1;

  return {
    group: letter,
    banked: me.banked,
    remaining: remCount,
    projTotal: round1(me.proj),
    rank,
    leads: rank === 1,
    winningBar,
    countries: countriesOf(letter, me.remaining),
    rivals: rivals.slice(0, 3).map((r) => ({
      group: r.letter,
      owner: ownerName(r.letter),
      proj: round1(r.proj)
    })),
    scenarios: unique
  };
}

function ownerName(letter) {
  const o = OWNERS.find((t) => t.group === letter);
  return o ? o.name : `Group ${letter} (unclaimed)`;
}

/* The four countries in a group, gathered from its remaining fixtures. */
function countriesOf(letter, remaining) {
  const set = [];
  remaining.forEach((m) => {
    [m.home, m.away].forEach((n) => {
      if (set.indexOf(n) < 0) set.push(n);
    });
  });
  return set;
}

/* ---------------- prose: built-in writer (no key) ---------------- */

function listAnd(arr) {
  if (arr.length <= 1) return arr.join("");
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(", ")} and ${arr[arr.length - 1]}`;
}

function templateIntro(entry, team) {
  const where = entry.leads
    ? "currently the top-projected group"
    : `projected ${entry.projTotal} goals — ${ordinal(entry.rank)} of 12`;
  const watch = entry.rivals.map((r) => `${r.owner} (Grp ${r.group})`);
  return (
    `${team} owns Group ${entry.group} — ${listAnd(entry.countries)} — ${where}. ` +
    `The No. 1 pick goes to the highest-scoring group, so Group ${entry.group} needs to clear ` +
    `~${entry.winningBar} goals while ${listAnd(watch)} stay in check.`
  );
}

function templateBlurb(s, entry) {
  const goals = `${s.yourRemainingGoals} goal${s.yourRemainingGoals === 1 ? "" : "s"} from the rest of Group ${entry.group}`;
  if (s.needsHelp) {
    return `${goals} gets you to ${s.targetTotal} — enough only if the chasers stall at ${s.rivalCap} or below.`;
  }
  return `${goals} pushes Group ${entry.group} to ${s.targetTotal}, clear of the field even if a rival overperforms.`;
}

function ordinal(n) {
  const m = n % 100;
  if (m >= 11 && m <= 13) return `${n}th`;
  return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
}

/* ---------------- prose: free LLM providers (optional) ---------------- */

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
const NIM_MODEL = process.env.NIM_MODEL || "meta/llama-3.3-70b-instruct";
const GH_MODELS_TOKEN = process.env.GH_MODELS_TOKEN || process.env.GITHUB_TOKEN || "";
const GH_MODEL = process.env.GH_MODEL || "openai/gpt-4o-mini";
const AI_ENABLED = !!NVIDIA_API_KEY || !!GH_MODELS_TOKEN;

function buildMessages(entry, team) {
  const facts =
    `Manager: ${team}. Owns World Cup Group ${entry.group} (${entry.countries.join(", ")}).\n` +
    `Draft rule: the No.1 pick goes to whichever of the 12 groups scores the most TOTAL goals; ` +
    `cards break ties.\n` +
    `Right now Group ${entry.group} has ${entry.banked} banked with ${entry.remaining} matches left, ` +
    `projected ${entry.projTotal} total (rank ${entry.rank} of 12). The toughest rival groups: ` +
    entry.rivals.map((r) => `${r.owner} ~${r.proj}`).join(", ") +
    `. To be safe the group needs about ${entry.winningBar}+ goals.\n` +
    `Scenarios:\n` +
    entry.scenarios
      .map(
        (s, i) =>
          `${i + 1}. "${s.label}": Group ${entry.group} reaches ${s.targetTotal} goals` +
          (s.needsHelp ? ` (needs rivals to stall at ${s.rivalCap} or under)` : ` (clear of the field)`)
      )
      .join("\n");

  const prompt =
    `You write punchy, factual fantasy-draft analysis for a World Cup hub. ` +
    `Using ONLY the facts below, return STRICT JSON (no markdown, no code fence) of the form ` +
    `{"intro":"...","blurbs":["...","..."]} where intro is 2 energetic sentences on what has to ` +
    `happen for ${team} to grab the No.1 pick, and blurbs has exactly ${entry.scenarios.length} ` +
    `one-sentence lines, one per scenario in order, each ~20 words, present tense. Name the rival ` +
    `managers where it adds bite. Do not invent numbers.\n\n${facts}`;

  return [
    { role: "system", content: "You write concise, factual football fantasy-draft takes and always return valid JSON." },
    { role: "user", content: prompt }
  ];
}

async function chatComplete(label, url, headers, body) {
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      console.error(`${label} ${res.status} ${res.statusText} — trying next provider.`);
      return null;
    }
    const data = await res.json();
    const text =
      data && data.choices && data.choices[0] && data.choices[0].message &&
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
    { Authorization: `Bearer ${NVIDIA_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    { model: NIM_MODEL, max_tokens: 400, temperature: 0.7, messages }
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
    { model: GH_MODEL, max_tokens: 400, temperature: 0.7, messages }
  );
}

const PROVIDERS = [
  { name: "NVIDIA NIM", on: () => !!NVIDIA_API_KEY, run: nvidiaNim },
  { name: "GitHub Models", on: () => !!GH_MODELS_TOKEN, run: githubModels }
];

/* Pull the JSON object out of a model reply, tolerating stray code fences or
   prose around it. Returns {intro, blurbs} or null. */
function parseReply(text, wantBlurbs) {
  if (!text) return null;
  let body = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a >= 0 && b > a) body = body.slice(a, b + 1);
  try {
    const obj = JSON.parse(body);
    const intro = typeof obj.intro === "string" ? obj.intro.trim() : "";
    const blurbs = Array.isArray(obj.blurbs) ? obj.blurbs.map((x) => String(x).trim()) : [];
    if (!intro || blurbs.length < wantBlurbs) return null;
    return { intro, blurbs };
  } catch (_) {
    return null;
  }
}

async function aiProse(entry, team) {
  const messages = buildMessages(entry, team);
  for (const p of PROVIDERS) {
    if (!p.on()) continue;
    const reply = await p.run(messages);
    const parsed = parseReply(reply, entry.scenarios.length);
    if (parsed) return { ...parsed, via: p.name };
  }
  return null;
}

/* ---------------- main ---------------- */

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/* Inputs that should force a fresh write + LLM call when they change. */
function fingerprint(entry) {
  return JSON.stringify([
    entry.banked,
    entry.remaining,
    entry.winningBar,
    entry.scenarios.map((s) => [s.targetTotal, s.lines.map((l) => [l.home, l.away, l.hg, l.ag])])
  ]);
}

async function main() {
  let live, odds;
  try {
    live = await readJson(LIVE);
  } catch (err) {
    console.error("live.json unreadable — leaving scenarios in place:", err.message);
    return;
  }
  try {
    odds = await readJson(ODDS);
  } catch (_) {
    odds = null; /* no market — Elo fills every fixture */
  }

  let prev = null;
  try {
    prev = await readJson(OUT);
  } catch (_) {}
  const prevByTeam = (prev && prev.byTeam) || {};

  const market = indexMarket(odds);
  const groups = readGroups(live, market);

  const byTeam = {};
  let aiCount = 0;
  let reusedCount = 0;

  for (const owner of OWNERS) {
    const entry = buildScenarios(owner.group, groups);
    if (!entry) continue;
    entry.abbr = owner.abbr;
    entry.team = owner.name;

    const fp = fingerprint(entry);
    const cached = prevByTeam[owner.abbr];
    const canReuse = cached && cached.fingerprint === fp && cached.intro && (cached.ai || !AI_ENABLED);

    if (canReuse) {
      entry.intro = cached.intro;
      entry.ai = !!cached.ai;
      entry.aiVia = cached.aiVia || null;
      entry.scenarios.forEach((s, i) => {
        const cs = cached.scenarios && cached.scenarios[i];
        s.blurb = cs && cs.blurb ? cs.blurb : templateBlurb(s, entry);
      });
      reusedCount += 1;
    } else {
      const ai = AI_ENABLED ? await aiProse(entry, owner.name) : null;
      entry.intro = ai ? ai.intro : templateIntro(entry, owner.name);
      entry.ai = !!ai;
      entry.aiVia = ai ? ai.via : null;
      entry.scenarios.forEach((s, i) => {
        s.blurb = ai && ai.blurbs[i] ? ai.blurbs[i] : templateBlurb(s, entry);
      });
      if (ai) aiCount += 1;
    }

    entry.fingerprint = fp;
    byTeam[owner.abbr] = entry;
  }

  const payload = {
    competition: "FWC2026",
    generatedAt: new Date().toISOString(),
    count: Object.keys(byTeam).length,
    byTeam
  };

  if (prev && stableEqual(prev.byTeam, byTeam)) {
    console.log(`No scenario changes (${payload.count} teams). Nothing to write.`);
    return;
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
  const providers = [NVIDIA_API_KEY && "NVIDIA NIM", GH_MODELS_TOKEN && "GitHub Models"]
    .filter(Boolean)
    .join(" → ");
  console.log(
    `Wrote ${payload.count} scenario sets (${aiCount} newly AI-written, ${reusedCount} reused, ` +
      `${AI_ENABLED ? "providers: " + providers : "built-in writer"}).`
  );
}

/* Deep-equal ignoring the volatile generatedAt timestamp. */
function stableEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exitCode = 0; /* never break the cron on a bad run */
});
