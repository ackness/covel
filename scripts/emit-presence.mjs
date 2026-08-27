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
import { assertPortraitPng } from "./lib/png-image-validation.mjs";

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
  const readPortraitRef = async (filename) => {
    let bytes;
    try {
      bytes = await readFile(path.join(mediaDir, "portraits", filename));
    } catch {
      missing.push(filename);
      return null;
    }
    assertPortraitPng(bytes, {
      size: manifest.defaults?.size ?? "1024x1536",
      background: manifest.style?.background,
      label: filename,
    });
    return {
      id: createHash("sha256").update(bytes).digest("hex"),
      mime: "image/png",
      size: bytes.length,
    };
  };

  const ref = await readPortraitRef(c.filename);
  if (!ref) continue;
  const defaultVisual = c.visual ?? {};
  const defaultVariantId = defaultVisual.id ?? "default";
  const visualVariants = [
    {
      id: defaultVariantId,
      outfit: defaultVisual.outfit ?? "default",
      expression: defaultVisual.expression ?? "neutral",
      pose: defaultVisual.pose ?? "default",
      sprite: ref,
      ...(defaultVisual.stage ? { stage: defaultVisual.stage } : {}),
    },
  ];
  for (const variant of Array.isArray(c.variants) ? c.variants : []) {
    const variantRef = await readPortraitRef(variant.filename);
    if (!variantRef) continue;
    visualVariants.push({
      id: variant.id,
      ...(variant.outfit ? { outfit: variant.outfit } : {}),
      ...(variant.expression ? { expression: variant.expression } : {}),
      ...(variant.pose ? { pose: variant.pose } : {}),
      sprite: variantRef,
      ...(variant.stage ? { stage: variant.stage } : {}),
    });
  }
  records.push({
    schemaVersion: 1,
    characterId: c.characterId,
    displayName: c.name,
    avatar: ref,
    sprite: ref,
    visuals: {
      defaultVariant: defaultVariantId,
      variants: visualVariants,
    },
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
