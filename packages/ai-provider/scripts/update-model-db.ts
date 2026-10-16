#!/usr/bin/env npx tsx
/**
 * Fetch the pinned LiteLLM model_prices_and_context_window.json snapshot,
 * transform it into our compact ModelDbEntry format, and write to data/model-db.json.
 *
 * Usage:
 *   npx tsx packages/ai-provider/scripts/update-model-db.ts
 *   # or via pnpm script:
 *   pnpm --filter @covel/ai-provider update-model-db
 */

import {
  transformLiteLlmEntry,
  type ModelDbEntry,
  type ModelDbFile,
} from "../src/capability/model-db.js";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, "../data/model-db.json");
const SOURCE_MANIFEST_PATH = resolve(__dirname, "../model-db-source.json");

// Release builds consume the committed output of this script. Update the
// revision and timestamp together, regenerate, review, and commit the JSON.
// Floating refs such as `main` would make tagged builds non-reproducible.
const sourceManifest = JSON.parse(
  readFileSync(SOURCE_MANIFEST_PATH, "utf-8"),
) as { revision: string; updatedAt: string };
const LITELLM_REVISION = sourceManifest.revision;
const LITELLM_UPDATED_AT = sourceManifest.updatedAt;
const LITELLM_URL = `https://raw.githubusercontent.com/BerriAI/litellm/${LITELLM_REVISION}/model_prices_and_context_window.json`;

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching LiteLLM model database from:\n  ${LITELLM_URL}\n`);

  const res = await fetch(LITELLM_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);
  }

  const raw = (await res.json()) as Record<string, Record<string, unknown>>;

  const models: Record<string, ModelDbEntry> = {};
  let skipped = 0;

  for (const [key, entry] of Object.entries(raw)) {
    const transformed = key.startsWith("sample_spec")
      ? null
      : transformLiteLlmEntry(entry);
    if (transformed) {
      models[key] = transformed;
    } else {
      skipped++;
    }
  }

  const db: ModelDbFile = {
    updatedAt: LITELLM_UPDATED_AT,
    source: LITELLM_URL,
    count: Object.keys(models).length,
    models,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(db, null, 2)}\n`, "utf-8");

  console.log(`Done! Written ${db.count} models to data/model-db.json`);
  if (skipped > 0) console.log(`  (skipped ${skipped} invalid/test entries)`);

  // Print some stats
  const modes = new Map<string, number>();
  for (const m of Object.values(models)) {
    modes.set(m.mode, (modes.get(m.mode) ?? 0) + 1);
  }
  console.log("\nMode distribution:");
  for (const [mode, count] of [...modes.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${mode}: ${count}`);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
