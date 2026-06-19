#!/usr/bin/env node
/*
  check-mobile-overflow.mjs — headless guard against horizontal overflow on
  phones, across every tab of the Hub.

  WHY THIS EXISTS
  On 2026-06-14 the Schedule cards went off-screen on mobile: the ≤700px rule
  used `grid-template-columns: 1fr` (= minmax(auto,1fr)), so a card's content
  width pushed the grid — and the whole page — wider than the phone. The CSS
  namespace guard can't see layout regressions like this, so this one renders
  the real pages in headless Chromium at phone width and fails if anything
  overflows. The trap that hid it from a naive check: with a mobile viewport,
  window.innerWidth itself inflates to the content width, so `scrollWidth >
  innerWidth` reads false. We therefore compare BOTH against the fixed device
  width, not against each other.

  Run: node scripts/check-mobile-overflow.mjs   (exit 1 on overflow)
  Needs: playwright chromium (npm ci && npx playwright install chromium).
*/

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEVICE_W = 390; // iPhone-class logical width
const DEVICE_H = 844;
const TOLERANCE = 1; // px, sub-pixel slack
const TABS = ["board", "schedule", "groups", "stats", "sim", "odds", "rules"];

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
};

/* Minimal static server so the app's relative fetch()es (data/*.json) work —
   file:// would trip CORS. */
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: DEVICE_W, height: DEVICE_H },
  isMobile: true, hasTouch: true, deviceScaleFactor: 2,
});
const page = await context.newPage();
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.Hub && window.Hub.ctx(), null, { timeout: 20000 })
  .catch(() => console.warn("⚠ Hub never readied — checking whatever rendered."));

const failures = [];
for (const tab of TABS) {
  await page.evaluate((t) => window.Hub && window.Hub.setTab && window.Hub.setTab(t), tab);
  await page.waitForTimeout(450);
  const r = await page.evaluate((W) => {
    const clippedByAncestor = (el) => {
      let n = el.parentElement;
      while (n && n !== document.body) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "hidden" || ox === "auto" || ox === "scroll") return true;
        n = n.parentElement;
      }
      return false;
    };
    let worst = null;
    for (const el of document.querySelectorAll("body *")) {
      const pos = getComputedStyle(el).position;
      // fixed/sticky elements (bg-glow, bottomnav, ...) stretch to whatever the
      // viewport already is — they're symptoms of overflow, never the cause.
      if (pos === "fixed" || pos === "sticky") continue;
      const rect = el.getBoundingClientRect();
      if (rect.right > W + 1 && !clippedByAncestor(el) && (!worst || rect.right > worst.right)) {
        worst = {
          tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === "string" ? el.className : "").slice(0, 50),
          right: Math.round(rect.right), width: Math.round(rect.width),
        };
      }
    }
    return {
      docW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      matchCards: document.querySelectorAll("#tab-schedule .match").length,
      worst,
    };
  }, DEVICE_W);

  const pageW = Math.max(r.docW, r.innerW);
  if (pageW > DEVICE_W + TOLERANCE) failures.push({ tab, pageW, worst: r.worst });
  if (tab === "schedule") console.log(`  (schedule rendered ${r.matchCards} match cards)`);
}

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n✗ Horizontal overflow at ${DEVICE_W}px on ${failures.length} tab(s):\n`);
  for (const f of failures) {
    const w = f.worst
      ? ` — widest unclipped: <${f.worst.tag} class="${f.worst.cls}"> reaches ${f.worst.right}px`
      : "";
    console.error(`  [${f.tab}] page is ${f.pageW}px wide (> ${DEVICE_W}px)${w}`);
  }
  console.error(
    "\nAn element is wider than the phone. Usual culprits: a grid `1fr`\n" +
      "(= minmax(auto,1fr)) that should be `minmax(0,1fr)`, or a nowrap element\n" +
      "without min-width:0. See the header of this script.\n"
  );
  process.exit(1);
}
console.log(`\n✓ No horizontal overflow — ${TABS.length} tabs clean at ${DEVICE_W}px.`);
