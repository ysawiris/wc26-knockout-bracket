#!/usr/bin/env node
/*
  check-css-prefixes.mjs — namespace guard for the Hub's CSS modules.

  WHY THIS EXISTS
  On 2026-06-14 The Race bump chart went blank on every phone. Root cause:
  the Recaps module (recaps.css) was authored reusing The Race's `rc-` class
  prefix, and its `@media (max-width:420px){ .rc-team{display:none} }` — meant
  to hide a country name in a recap goal row — also matched The Race's
  `.rc-team` bump-lines and hid the whole chart on screens <=420px. It shipped
  straight to production because GitHub Pages deploys from the branch root with
  no build/test gate.

  This script is that missing gate. Each feature stylesheet owns ONE class
  prefix; styling a class that belongs to a DIFFERENT module's prefix is the
  exact bug above, and fails the check. Shared global components and shared
  state/modifier classes (.row, .match, .is-active, .mine, .up, ...) live in
  the shared sheets and are never feature-prefixed, so they're never flagged.

  Run: node scripts/check-css-prefixes.mjs   (exit 1 on collision)
*/

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CSS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "css");

/* Each feature module owns a unique prefix (token before the first hyphen of
   its class names). Keep this in sync when adding a module — that is the
   point: a new module must claim its own namespace here. */
const FEATURE_PREFIX_OWNER = {
  rc: "race.css",          // The Race bump chart
  rcp: "recaps.css",       // AI match recaps modal
  mc: "matchcenter.css",   // Match Center panel
  st: "stats.css",         // Stats & Records
  od: "odds.css",          // Pick Odds
  road: "road.css",        // Road to No. 1
  bx: "board-extras.css",  // board toolbar / extras
  ga: "alerts.css",        // goal alerts
  tp: "my-team.css",       // team picker
  sc: "share-card.css",    // share card
};

/* Shared sheets define the global components (.row, .match, .tab, .hero-pill,
   .bottomnav, .m-*, ...). They may style anything and are not prefix-owned. */
const SHARED_SHEETS = new Set(["styles.css", "extras.css"]);

function classTokensOf(css) {
  // strip comments, then collect every `.class` selector token
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Map(); // fullClass -> prefix token (before first hyphen)
  const re = /\.([A-Za-z_][A-Za-z0-9_-]*)/g;
  let m;
  while ((m = re.exec(noComments))) {
    const full = m[1];
    found.set(full, full.includes("-") ? full.slice(0, full.indexOf("-")) : full);
  }
  return found;
}

const violations = [];
for (const file of readdirSync(CSS_DIR).filter((f) => f.endsWith(".css")).sort()) {
  if (SHARED_SHEETS.has(file)) continue;
  const tokens = classTokensOf(readFileSync(join(CSS_DIR, file), "utf8"));
  for (const [full, prefix] of tokens) {
    const owner = FEATURE_PREFIX_OWNER[prefix];
    if (owner && owner !== file) {
      violations.push({ file, cls: `.${full}`, prefix, owner });
    }
  }
}

if (violations.length) {
  console.error("✗ CSS namespace collision(s) — a module is styling another module's classes:\n");
  for (const v of violations) {
    console.error(`  ${v.file}  styles  ${v.cls}  (the '${v.prefix}-' namespace belongs to ${v.owner})`);
  }
  console.error(
    "\nFix: give each module its own prefix. This is the bug that hid The Race\n" +
      "behind recaps' .rc-team{display:none}. See the header of this script.\n"
  );
  process.exit(1);
}

console.log(`✓ CSS namespaces clean — ${Object.keys(FEATURE_PREFIX_OWNER).length} modules, no cross-module class styling.`);
