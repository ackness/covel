#!/usr/bin/env node
/**
 * emit-presence.mjs — build worlds/<world>/media/presence.json from generated portraits.
 *
 * Scans worlds/<world>/media/portraits/, content-addresses each PNG with sha256
 * (the same hash the media store assigns on import, packages/store media-store
 * utils.sha256), maps filename → characterId via portraits.json, and writes
 * character-presence `presence` records that point avatar + sprite at the image.
 * Re-run after regenerating portraits to refresh the hashes.
 *
 * Usage: node scripts/emit-presence.mjs <world>
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const world = process.argv[2];
if (!world) {
  console.error("usage: node scripts/emit-presence.mjs <world>");
  process.exit(1);
}

const mediaDir = path.join(repoRoot, "worlds", world, "media");
const manifest = JSON.parse(
  await readFile(path.join(mediaDir, "portraits.json"), "utf-8"),
);

const records = [];
const missing = [];
for (const c of manifest.characters) {
  let bytes;
  try {
    bytes = await readFile(path.join(mediaDir, "portraits", c.filename));
  } catch {
    missing.push(c.filename);
    continue;
  }
  const ref = {
    id: createHash("sha256").update(bytes).digest("hex"),
    mime: "image/png",
    size: bytes.length,
  };
  records.push({
    schemaVersion: 1,
    characterId: c.characterId,
    displayName: c.name,
    avatar: ref,
    sprite: ref,
  });
}

await writeFile(
  path.join(mediaDir, "presence.json"),
  JSON.stringify(records, null, 2) + "\n",
);
console.log(
  `wrote worlds/${world}/media/presence.json with ${records.length} presence record(s)`,
);
if (missing.length)
  console.log(`  (missing portraits, skipped: ${missing.join(", ")})`);
