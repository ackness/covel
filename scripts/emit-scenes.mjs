#!/usr/bin/env node
/**
 * emit-scenes.mjs — build worlds/<world>/media/scenes.registry.json from
 * generated scene backgrounds.
 *
 * Resolves expected filenames from scenes.json and probes
 * worlds/<world>/media/scenes/, content-addresses each PNG with sha256
 * (the media store assigns the same hash on import), and maps
 * sceneId → { day, night } MediaRefs via scenes.json. Scenes missing the DAY
 * image are skipped with a warning (day is the base variant); a missing
 * night image is recorded as null (runtime falls back to day).
 * Re-run after regenerating scenes to refresh the hashes.
 *
 * Usage: node scripts/emit-scenes.mjs <world>
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const world = process.argv[2];
if (!world) {
  console.error("usage: node scripts/emit-scenes.mjs <world>");
  process.exit(1);
}

const mediaDir = path.join(repoRoot, "worlds", world, "media");
const manifest = JSON.parse(
  await readFile(path.join(mediaDir, "scenes.json"), "utf-8"),
);

async function refOf(filename) {
  try {
    const bytes = await readFile(path.join(mediaDir, "scenes", filename));
    return {
      id: createHash("sha256").update(bytes).digest("hex"),
      mime: "image/png",
      size: bytes.length,
    };
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err; // permission/IO errors are real failures, not "missing" — surface them
  }
}

const scenes = [];
const skipped = [];
for (const s of manifest.scenes ?? []) {
  const day = await refOf(`${s.id}-day.png`);
  if (!day) {
    skipped.push(s.id);
    continue;
  }
  scenes.push({
    sceneId: s.id,
    name: s.name,
    ...(s.locationRef ? { locationRef: s.locationRef } : {}),
    day,
    night: await refOf(`${s.id}-night.png`),
  });
}

await writeFile(
  path.join(mediaDir, "scenes.registry.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      registryId: "scene-registry",
      ...(manifest.style ? { style: manifest.style } : {}),
      scenes,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `wrote worlds/${world}/media/scenes.registry.json with ${scenes.length} scene(s)`,
);
if (skipped.length)
  console.log(`  (missing day image, skipped: ${skipped.join(", ")})`);
