#!/usr/bin/env node
/**
 * generate-portraits.mjs — batch-generate character portraits for a world.
 *
 * Reads worlds/<world>/media/portraits.json, composes each prompt as
 * style.prefix + character.subject + style.suffix, and generates through
 * the framework's image wire (packages/ai-provider/src/image/wire-registry.ts
 * — same wire the openai-image-gen / dashscope-image-gen plugins use, no
 * hand-rolled HTTP here). Saves PNGs to
 * worlds/<world>/media/portraits/<filename>.
 *
 * Provider config is NOT hardcoded here — it is read from a slot in
 * ~/.covel/llm.toml (baseUrl / model / provider / providerRequestMetadata
 * .imageWire). The API key is read from ~/.covel/keys.env by the
 * `<PROVIDER>_API_KEY` convention. Pick the slot with --slot; switch
 * providers by editing llm.toml, never this script.
 *
 * This script imports framework TS source directly (no build step for
 * dev packages), so it must run under tsx, not plain node:
 *
 *   npx tsx scripts/generate-portraits.mjs <world> [--slot gpt-image-2]
 *        [--only id1,id2] [--size WxH] [--quality low|medium|high]
 *        [--limit N] [--concurrency N] [--force] [--dry-run]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  exists,
  pool,
  fetchImageBytes,
  resolveImageWire,
  reportResults,
} from "./lib/image-gen-common.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const DEFAULT_SLOT = "gpt-image-2";
const DEFAULT_CONCURRENCY = 5;

function parseArgs(argv) {
  const args = {
    force: false,
    dryRun: false,
    concurrency: DEFAULT_CONCURRENCY,
    slot: DEFAULT_SLOT,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") args.only = new Set(argv[++i].split(","));
    else if (a === "--size") args.size = argv[++i];
    else if (a === "--quality") args.quality = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--concurrency")
      args.concurrency = Math.max(1, Number(argv[++i]) || DEFAULT_CONCURRENCY);
    else if (a === "--slot") args.slot = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--chroma") args.chroma = true;
    else if (a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
    else rest.push(a);
  }
  args.world = rest[0];
  return args;
}

// --chroma: providers that reject the background=transparent parameter draw a
// flat pure-green backdrop instead; strip it locally afterwards, e.g.
//   magick sprite.png -alpha set -fuzz 12% -fill none \
//     -draw 'color 0,0 floodfill' ... (see worlds/PORTRAITS.md)
const CHROMA_PROMPT =
  ", standing against a solid uniform flat pure green (#00FF00) chroma-key backdrop filling the entire background, no background scenery, no shadow on the backdrop";

function buildPrompt(style, character, chroma = false) {
  const { prefix = "", suffix = "", negative = "" } = style;
  const chromaPart = chroma ? CHROMA_PROMPT : "";
  return `${prefix}${character.subject}${suffix}${chromaPart}${negative ? `\n\nAvoid: ${negative}` : ""}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.world) {
    console.error(
      "usage: npx tsx scripts/generate-portraits.mjs <world> [--slot gpt-image-2] [--only id1,id2] [--size 1024x1536] [--quality medium] [--limit N] [--concurrency 5] [--force] [--dry-run]",
    );
    process.exit(1);
  }

  const manifest = JSON.parse(
    await readFile(
      path.join(repoRoot, "worlds", args.world, "media", "portraits.json"),
      "utf-8",
    ),
  );
  const size = args.size || manifest.defaults?.size || "1024x1536";
  const quality = args.quality || manifest.defaults?.quality || "medium";
  const style = manifest.style || {};

  let chars = manifest.characters;
  if (args.only) chars = chars.filter((c) => args.only.has(c.id));
  if (args.limit) chars = chars.slice(0, args.limit);

  const queue = chars.map((c) => ({
    id: c.id,
    name: c.name,
    filename: c.filename,
    prompt: buildPrompt(style, c, args.chroma),
  }));

  if (args.dryRun) {
    console.log(
      `world=${args.world} slot=${args.slot} size=${size} quality=${quality} — ${queue.length} portrait(s) queued (dry-run, no network calls):\n`,
    );
    for (const q of queue) {
      console.log(`  ${q.id} → ${q.filename}`);
      console.log(`    ${q.prompt.replace(/\n/g, "\n    ")}\n`);
    }
    return;
  }

  const outDir = path.join(
    repoRoot,
    "worlds",
    args.world,
    "media",
    "portraits",
  );
  await mkdir(outDir, { recursive: true });

  const {
    wire,
    wireId,
    model: slotModel,
    slot,
    config,
  } = await resolveImageWire(args.slot);
  // --model overrides the slot's model (e.g. gpt-image-1 for transparent sprites
  // when the slot's default model rejects the background parameter).
  const model = args.model ?? slotModel;

  // Filter out already-present files up front (unless --force).
  const todo = [];
  for (const c of chars) {
    if (!args.force && (await exists(path.join(outDir, c.filename)))) {
      console.log(`  ⏭  ${c.name} (${c.filename}) exists — skip`);
    } else {
      todo.push(c);
    }
  }

  console.log(
    `world=${args.world} slot=${args.slot} (provider=${slot.provider}, wire=${wireId}) model=${model} size=${size} quality=${quality} concurrency=${args.concurrency}`,
  );
  console.log(
    `generating ${todo.length} portrait(s) concurrently → worlds/${args.world}/media/portraits/\n`,
  );

  const results = await pool(todo, args.concurrency, async (c) => {
    const prompt = buildPrompt(style, c, args.chroma);
    const t0 = Date.now();
    try {
      const bytes = await fetchImageBytes({
        wire,
        config,
        model,
        prompt,
        size,
        quality,
        background: args.chroma ? undefined : style.background,
      });
      await writeFile(path.join(outDir, c.filename), bytes);
      console.log(
        `  ✅ ${c.name} (${c.filename}) ${(bytes.length / 1024).toFixed(0)} KB · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      return { id: c.id, status: "ok" };
    } catch (err) {
      console.log(`  ❌ ${c.name} (${c.filename}) ${err.message}`);
      return { id: c.id, status: "failed", error: err.message };
    }
  });

  reportResults(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
