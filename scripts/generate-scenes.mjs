#!/usr/bin/env node
/**
 * generate-scenes.mjs — batch-generate GalGame scene backgrounds for a world.
 *
 * Reads worlds/<world>/media/scenes.json; every scene yields TWO tasks:
 *   day   : style.prefix + subject + style.suffix
 *   night : style.prefix + (subjectNight || subject) + style.suffix + style.nightSuffix
 * Files land in worlds/<world>/media/scenes/<id>-day.png / <id>-night.png.
 *
 * Provider config comes from ~/.covel/llm.toml via --slot (see
 * scripts/lib/image-gen-common.mjs). Runs under tsx:
 *
 *   npx tsx scripts/generate-scenes.mjs <world> [--slot gpt-image-2]
 *        [--only id1,id2] [--variant day|night] [--size WxH] [--quality q]
 *        [--limit N] [--concurrency N] [--force] [--dry-run]
 *        [--scaffold] [--landmarks]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
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
const VARIANTS = ["day", "night"];

function parseArgs(argv) {
  const args = {
    force: false,
    dryRun: false,
    scaffold: false,
    landmarks: false,
    concurrency: DEFAULT_CONCURRENCY,
    slot: DEFAULT_SLOT,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") args.only = new Set(argv[++i].split(","));
    else if (a === "--variant") args.variant = argv[++i];
    else if (a === "--size") args.size = argv[++i];
    else if (a === "--quality") args.quality = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--concurrency")
      args.concurrency = Math.max(1, Number(argv[++i]) || DEFAULT_CONCURRENCY);
    else if (a === "--slot") args.slot = argv[++i];
    else if (a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--scaffold") args.scaffold = true;
    else if (a === "--landmarks") args.landmarks = true;
    else rest.push(a);
  }
  args.world = rest[0];
  if (args.variant && !VARIANTS.includes(args.variant)) {
    console.error(`--variant must be one of: ${VARIANTS.join("|")}`);
    process.exit(1);
  }
  return args;
}

function buildScenePrompt(style, scene, variant) {
  const { prefix = "", suffix = "", negative = "", nightSuffix = "" } = style;
  const subject =
    variant === "night" && scene.subjectNight
      ? scene.subjectNight
      : scene.subject;
  const night = variant === "night" ? nightSuffix : "";
  return `${prefix}${subject}${suffix}${night}${negative ? `\n\nAvoid: ${negative}` : ""}`;
}

function sceneTasks(manifest, args) {
  let scenes = manifest.scenes ?? [];
  if (args.only) scenes = scenes.filter((s) => args.only.has(s.id));
  if (args.limit) scenes = scenes.slice(0, args.limit);
  const variants = args.variant ? [args.variant] : VARIANTS;
  const tasks = [];
  for (const scene of scenes) {
    if (!scene.subject) {
      console.log(
        `  ⏭  ${scene.id} has an empty subject — polish scenes.json first, skip`,
      );
      continue;
    }
    for (const variant of variants) {
      tasks.push({
        scene,
        variant,
        filename: `${scene.id}-${variant}.png`,
        prompt: buildScenePrompt(manifest.style ?? {}, scene, variant),
      });
    }
  }
  return tasks;
}

function slugify(index) {
  return `scene-${String(index + 1).padStart(2, "0")}`;
}

async function scaffold(args) {
  const dimPath = path.join(
    repoRoot,
    "worlds",
    args.world,
    "data",
    "dimensions.yaml",
  );
  const dims = parseYaml(await readFile(dimPath, "utf-8"));
  // dimensions.yaml nests the region list under geography.regions (verified
  // against worlds/haruka-academy/data/dimensions.yaml — NOT location.regions).
  const regions = dims?.geography?.regions ?? [];
  if (regions.length === 0) {
    console.error(`no regions found in ${dimPath} — nothing to scaffold`);
    process.exit(1);
  }

  const manifestPath = path.join(
    repoRoot,
    "worlds",
    args.world,
    "media",
    "scenes.json",
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  } catch {
    manifest = {
      world: args.world,
      note: "Generation manifest for scene backgrounds. Prompts compose as style.prefix + scene.subject + style.suffix (+ style.nightSuffix for the night variant). Rename scaffolded ids to meaningful slugs, then polish every subject into an English visual description before generating.",
      style: {
        direction: "anime visual-novel background, painterly",
        prefix: "Visual novel background art, anime scenery style, no people, ",
        suffix: ", clean composition, GalGame background",
        negative:
          "people, character, figure, text, caption, watermark, logo, frame",
        nightSuffix: ", at night, moonlight, warm artificial lights",
      },
      defaults: { size: "1536x1024", quality: "medium", mime: "image/png" },
      scenes: [],
    };
  }

  const existingRefs = new Set(
    manifest.scenes.map((s) => s.locationRef).filter(Boolean),
  );
  let added = 0;
  const pushDraft = (name, description) => {
    if (existingRefs.has(name)) return; // never overwrite / duplicate
    manifest.scenes.push({
      id: slugify(manifest.scenes.length),
      name,
      locationRef: name, // dimensions.yaml has no ids — name IS the identity
      subject: description, // verbatim draft; author polishes into English scenery prose
      subjectNight: "",
    });
    existingRefs.add(name);
    added += 1;
  };

  for (const region of regions) {
    const desc = [region.description, region.climate].filter(Boolean).join(" ");
    pushDraft(region.name, desc);
    if (args.landmarks) {
      for (const lm of region.landmarks ?? []) {
        pushDraft(lm.name, lm.description ?? "");
      }
    }
  }

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `scaffolded ${added} new scene draft(s) into worlds/${args.world}/media/scenes.json (${manifest.scenes.length} total). Rename ids + polish subjects, then re-run with --dry-run.`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.world) {
    console.error(
      "usage: npx tsx scripts/generate-scenes.mjs <world> [--slot gpt-image-2] [--only id1,id2] [--variant day|night] [--size 1536x1024] [--quality medium] [--limit N] [--concurrency 5] [--force] [--dry-run] [--scaffold] [--landmarks]",
    );
    process.exit(1);
  }

  if (args.scaffold) {
    await scaffold(args);
    return;
  }

  const manifest = JSON.parse(
    await readFile(
      path.join(repoRoot, "worlds", args.world, "media", "scenes.json"),
      "utf-8",
    ),
  );
  const size = args.size || manifest.defaults?.size || "1536x1024";
  const quality = args.quality || manifest.defaults?.quality || "medium";
  const style = manifest.style || {};

  const tasks = sceneTasks(manifest, args);

  if (args.dryRun) {
    console.log(
      `world=${args.world} slot=${args.slot} size=${size} quality=${quality} — ${tasks.length} scene task(s) queued (dry-run, no network calls):\n`,
    );
    for (const t of tasks) {
      console.log(`  ${t.scene.id} [${t.variant}] → ${t.filename}`);
      console.log(`    ${t.prompt.replace(/\n/g, "\n    ")}\n`);
    }
    return;
  }

  const outDir = path.join(repoRoot, "worlds", args.world, "media", "scenes");
  await mkdir(outDir, { recursive: true });

  const { wire, wireId, model, slot, config } = await resolveImageWire(
    args.slot,
  );

  // Filter out already-present files up front (unless --force).
  const todo = [];
  for (const t of tasks) {
    if (!args.force && (await exists(path.join(outDir, t.filename)))) {
      console.log(
        `  ⏭  ${t.scene.id} [${t.variant}] (${t.filename}) exists — skip`,
      );
    } else {
      todo.push(t);
    }
  }

  console.log(
    `world=${args.world} slot=${args.slot} (provider=${slot.provider}, wire=${wireId}) model=${model} size=${size} quality=${quality} concurrency=${args.concurrency}`,
  );
  console.log(
    `generating ${todo.length} scene image(s) concurrently → worlds/${args.world}/media/scenes/\n`,
  );

  const results = await pool(todo, args.concurrency, async (t) => {
    const t0 = Date.now();
    try {
      const bytes = await fetchImageBytes({
        wire,
        config,
        model,
        prompt: t.prompt,
        size,
        quality,
        background: style.background,
      });
      await writeFile(path.join(outDir, t.filename), bytes);
      console.log(
        `  ✅ ${t.scene.id} [${t.variant}] (${t.filename}) ${(bytes.length / 1024).toFixed(0)} KB · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      return { id: t.filename, status: "ok" };
    } catch (err) {
      console.log(
        `  ❌ ${t.scene.id} [${t.variant}] (${t.filename}) ${err.message}`,
      );
      return { id: t.filename, status: "failed", error: err.message };
    }
  });

  reportResults(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
