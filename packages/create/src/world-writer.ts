/**
 * World package file writing.
 *
 * Persists dimensions and optional portable characters/lore through a v1
 * worldData descriptor so generated worlds use the hand-authored import path.
 */

import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { canonicalizeLocale, validateWorldManifest } from "@covel/shared";
import type { GeneratedWorld, GeneratedWorldPackageContent } from "./types.js";

const GENERATED_WORLD_DATA_PATH = "data/world.data.yaml";

/**
 * A file that says this package was written by the generator. Such a
 * package holds nothing but what the generator writes, so it can be written
 * again from a revised world. A package made by hand or installed from
 * elsewhere may hold media, extra sources and translations that a rewrite
 * would lose: it has no marker and is never rewritten.
 */
export const GENERATED_WORLD_MARKER = ".covel-generated.json";
const GENERATED_DIMENSIONS_PATH = "data/dimensions.yaml";

/** Publish one complete package without overwriting an existing world. */
export async function writeWorldPackage(
  outputDir: string,
  world: GeneratedWorld,
  /**
   * `replace` writes over the package of the same id, for a revised world.
   * The old directory is kept until the new one is in place, so a failure
   * leaves the old package as it was.
   */
  options: { readonly replace?: boolean } = {},
): Promise<string[]> {
  const { id, lore, packageContent } = world;
  const locale = canonicalizeLocale(world.locale);
  if (
    !locale ||
    world.manifest.id !== id ||
    !validateWorldManifest(world.manifest).valid
  ) {
    throw new Error("Cannot export an invalid generated world");
  }
  // Export replaces inline content with file references in its own copy only.
  const manifest = structuredClone(world.manifest);
  const finalDir = path.join(outputDir, id);
  const exists = await lstat(finalDir).then(
    () => true,
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    },
  );
  if (exists && !options.replace)
    throw new Error(`World package already exists: ${id}`);
  if (!exists && options.replace)
    throw new Error(`World package does not exist: ${id}`);
  await mkdir(outputDir, { recursive: true });
  const staging = await mkdtemp(path.join(outputDir, ".covel-create-"));
  try {
    const files = await writeWorldDataFiles(staging, manifest, packageContent);
    await writeFile(
      path.join(staging, GENERATED_WORLD_MARKER),
      `${JSON.stringify({ schemaVersion: 1 })}\n`,
      "utf8",
    );
    await writeFile(path.join(staging, `WORLD.${locale}.md`), lore, "utf8");
    await writeFile(path.join(staging, "WORLD.md"), lore, "utf8");
    await writeFile(
      path.join(staging, "world.yaml"),
      stringifyYaml(manifest, { lineWidth: 0 }),
      "utf8",
    );
    if (options.replace) {
      const previous = await mkdtemp(path.join(outputDir, ".covel-replaced-"));
      const kept = path.join(previous, "package");
      await rename(finalDir, kept);
      try {
        await rename(staging, finalDir);
      } catch (error) {
        await rename(kept, finalDir);
        throw error;
      } finally {
        await rm(previous, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      // Concurrent creators race only at publication; a complete winner is
      // non-empty and cannot be replaced by the loser's directory rename.
      await rename(staging, finalDir);
    }
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
  const contractData = packageContent?.contractData ?? [];
  const lorebook = [
    ...(packageContent?.lorebook ?? []),
    ...(packageContent?.rules ?? []),
  ];
  if (
    !hasDimensions &&
    characters.length === 0 &&
    lorebook.length === 0 &&
    contractData.length === 0
  ) {
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

  for (const [index, record] of contractData.entries()) {
    const recordPath = `data/contract-${index}.json`;
    await writeFile(
      path.join(worldDir, recordPath),
      `${JSON.stringify(record.value, null, 2)}\n`,
      "utf8",
    );
    written.push(recordPath);
    sources[`contract${index}`] = {
      kind: "json",
      path: recordPath,
      schema: `contract:${record.contract}`,
      to: `contract:${record.contract}${record.lorebook ? "+lorebook" : ""}`,
      key: "id",
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
