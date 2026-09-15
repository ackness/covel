/**
 * World package file writing.
 *
 * Persists dimensions and optional portable characters/lore through a v1
 * worldData descriptor so generated worlds use the hand-authored import path.
 */

import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { GeneratedWorldPackageContent } from "./types.js";

const GENERATED_WORLD_DATA_PATH = "data/world.data.yaml";
const GENERATED_DIMENSIONS_PATH = "data/dimensions.yaml";

/** Publish one complete package without overwriting an existing world. */
export async function writeWorldPackage(
  outputDir: string,
  id: string,
  manifest: Record<string, unknown>,
  lore: string,
  locale: string,
  packageContent?: GeneratedWorldPackageContent,
): Promise<string[]> {
  const finalDir = path.join(outputDir, id);
  try {
    await lstat(finalDir);
    throw new Error(`World package already exists: ${id}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(outputDir, { recursive: true });
  const staging = await mkdtemp(path.join(outputDir, ".covel-create-"));
  try {
    const files = await writeWorldDataFiles(staging, manifest, packageContent);
    await writeFile(path.join(staging, `WORLD.${locale}.md`), lore, "utf8");
    await writeFile(path.join(staging, "WORLD.md"), lore, "utf8");
    await writeFile(
      path.join(staging, "world.yaml"),
      stringifyYaml(manifest, { lineWidth: 0 }),
      "utf8",
    );
    // Concurrent creators race only at publication; a complete winner is
    // non-empty and cannot be replaced by the loser's directory rename.
    await rename(staging, finalDir);
    return [...files, "world.yaml", `WORLD.${locale}.md`, "WORLD.md"].map(
      (file) => `${id}/${file}`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Write all generated structured text through a v1 worldData descriptor.
 */
export async function writeWorldDataFiles(
  worldDir: string,
  manifest: Record<string, unknown>,
  packageContent?: GeneratedWorldPackageContent,
): Promise<string[]> {
  const inline = manifest.dimensions as Record<string, unknown> | undefined;
  const hasDimensions = Boolean(
    inline && typeof inline === "object" && Object.keys(inline).length > 0,
  );
  const characters = packageContent?.characters ?? [];
  const lorebook = [
    ...(packageContent?.lorebook ?? []),
    ...(packageContent?.rules ?? []),
  ];
  if (!hasDimensions && characters.length === 0 && lorebook.length === 0) {
    return [];
  }

  const dataDir = path.join(worldDir, "data");
  await mkdir(dataDir, { recursive: true });
  const written: string[] = [];
  const sources: Record<string, Record<string, unknown>> = {};

  if (hasDimensions) {
    const dimensionsPath = path.join(worldDir, GENERATED_DIMENSIONS_PATH);
    await writeFile(
      dimensionsPath,
      stringifyYaml(inline, { lineWidth: 0 }),
      "utf-8",
    );
    written.push(GENERATED_DIMENSIONS_PATH);
    sources.dimensions = {
      kind: "yaml",
      path: GENERATED_DIMENSIONS_PATH,
      schema: "covel://world/dimensions",
      to: "world:metadata.dimensions",
    };
    delete manifest.dimensions;
    delete manifest.dimensionSources;
  }

  if (characters.length > 0) {
    const charactersPath = "characters/main-cast.json";
    await mkdir(path.join(worldDir, "characters"), { recursive: true });
    await writeFile(
      path.join(worldDir, charactersPath),
      `${JSON.stringify(characters, null, 2)}\n`,
      "utf-8",
    );
    written.push(charactersPath);
    sources.cast = {
      kind: "json",
      path: charactersPath,
      to: "characters",
      key: "id",
      ...(hasDimensions ? { after: "dimensions" } : {}),
    };
    // Keep a portable fallback for store-only/browser worlds. File-backed
    // worlds import `cast` through worldData and therefore never execute the
    // fallback, avoiding duplicate characters.
    manifest.characterBlueprintSources = [charactersPath];
  }

  if (lorebook.length > 0) {
    const lorebookPath = "data/lorebook.yaml";
    await writeFile(
      path.join(worldDir, lorebookPath),
      stringifyYaml(lorebook, { lineWidth: 0 }),
      "utf-8",
    );
    written.push(lorebookPath);
    sources.lorebook = {
      kind: "yaml",
      path: lorebookPath,
      to: "lorebook",
      key: "id",
      ...(hasDimensions ? { after: "dimensions" } : {}),
    };
  }

  const descriptorPath = path.join(worldDir, GENERATED_WORLD_DATA_PATH);
  await writeFile(
    descriptorPath,
    stringifyYaml(
      {
        schemaVersion: 1,
        sources,
      },
      { lineWidth: 0 },
    ),
    "utf-8",
  );
  manifest.worldData = GENERATED_WORLD_DATA_PATH;
  written.push(GENERATED_WORLD_DATA_PATH);

  return written;
}
