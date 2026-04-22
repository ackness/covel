#!/usr/bin/env node
/**
 * One-off Playwright script to capture the three README hero screenshots
 * against the running dev server. Replaces the stale Apr-20 versions.
 *
 * Run: node scripts/capture-readme-shots.mjs
 *
 * Requires: dev server up at http://localhost:5173, a session id with content,
 * and `chromium install` (already done by playwright install).
 */
import { chromium } from "playwright";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..");
const OUT = resolve(REPO, ".assets/images");

const SESSION_ID = process.env.SESSION_ID ?? "neonridge-a380236e";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await ctx.newPage();

await page.addInitScript(() => {
  localStorage.setItem("covel:keys", JSON.stringify({ DEEPSEEK_API_KEY: "sk-screenshot-placeholder" }));
  localStorage.setItem(
    "covel:settings",
    JSON.stringify({
      schemaVersion: 1,
      entries: { "ui.onboardedVersion": 999 },
    }),
  );
});

async function take(file) {
  // Wait for layout to settle
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(800);
  const path = resolve(OUT, file);
  await page.screenshot({ path, type: "jpeg", quality: 88 });
  console.log(`[shot] ${file}`);
}

// 1. Main session view — narrative + plugin messages, world panel on right
await page.goto(`${BASE}/session?sid=${SESSION_ID}`);
await page.waitForSelector("main", { timeout: 10_000 });
await page.waitForTimeout(1500);
await take("Jietu20260420-150324.jpg");

// 2. World select screen — second showcase shot for the README. Shows the
// editorial header, the AI-generate CTA card, and the new world card grid.
await page.goto(`${BASE}/session`);
await page.waitForSelector("article", { timeout: 10_000 });
await page.waitForTimeout(1200);
await take("Jietu20260420-150417.jpg");

// 3. Debug page
await page.goto(`${BASE}/debug?sid=${SESSION_ID}`);
await page.waitForSelector("main", { timeout: 10_000 });
await page.waitForTimeout(1500);
await take("debug.jpg");

await browser.close();
console.log("[done] saved to .assets/images/");
