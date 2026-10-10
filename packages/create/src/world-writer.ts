/**
 * World package file writing.
 *
 * A generated world is laid out as a hand-authored one: each file at the path
 * the world conventions give it, in one language. A package whose files are
 * all at such paths has no descriptor; one is written only for records of a
 * contract with no path of its own: its plugin names none, or names one that
 * another source has.
 */

import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { canonicalizeLocale, validateWorldManifest } from "@covel/shared";
import type {
  GeneratedWorld,
  GeneratedWorldPackageContent,
  WorldGenerationDataContract,
} from "./types.js";

const GENERATED_WORLD_DATA_PATH = "data/world.data.yaml";

/**
 * A file that says this package was written by the generator. Such a
 * package holds nothing but what the generator writes, so it can be written
 * again from a revised world. A package made by hand or installed from
 * elsewhere may hold media, extra sources and translations that a rewrite
 * would lose: it has no marker and is never rewritten.
 */
export const GENERATED_WORLD_MARKER = ".covel-generated.json";

/** Publication and restoration both failed; the complete old package remains. */
export class WorldPackageRecoveryError extends AggregateError {
  constructor(
    readonly backupPath: string,
    errors: readonly unknown[],
  ) {
    super(
      errors,
      `World replacement failed; the original package is preserved at ${backupPath}`,
    );
    this.name = "WorldPackageRecoveryError";
  }
}
// The paths the kernel reads without a descriptor.
const GENERATED_DIMENSIONS_PATH = "data/dimensions.yaml";
const GENERATED_CHARACTERS_PATH = "characters/characters.json";
const GENERATED_LOREBOOK_PATH = "data/lorebook.yaml";

/**
 * The files of a package that are not a contract's to name: the ones the
 * kernel reads and the ones the generator writes itself.
 */
const RESERVED_PATHS = [
  GENERATED_WORLD_MARKER,
  "WORLD.md",
  "world.yaml",
  GENERATED_WORLD_DATA_PATH,
  GENERATED_DIMENSIONS_PATH,
  GENERATED_CHARACTERS_PATH,
  GENERATED_LOREBOOK_PATH,
];

/** What the writer needs to know about a contract: where its records go. */
type ContractFile = Pick<WorldGenerationDataContract, "contract" | "source">;

/**
 * The place of a package file on disk. A path that a plugin names is not
 * trusted to stay inside the package.
 */
function packageFile(worldDir: string, file: string): string {
  const root = path.resolve(worldDir);
  const full = path.resolve(root, file);
  const relative = path.relative(root, full);
  if (
    path.isAbsolute(file) ||
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(`World data path is outside the package: ${file}`);
  return full;
}

/** One file for paths that differ in spelling only, as on a disk that ignores case. */
function fileKey(file: string): string {
  return path.posix.normalize(file.replaceAll("\\", "/")).toLowerCase();
}

export interface WriteWorldPackageOptions {
  /**
   * `replace` writes over the package of the same id, for a revised world.
   * The old directory is kept until the new one is in place, so a failure
   * leaves the old package as it was.
   */
  readonly replace?: boolean;
  /**
   * With `replace`: runs once the new package is in place, before the old one
   * is dropped. If it throws, the old package is put back and the error is
   * rethrown, so the caller can tie the swap to its own read-back and record
   * update.
   */
  readonly afterPublish?: () => Promise<void>;
  /** The contracts the world was generated with; each may name its file. */
  readonly dataContracts?: readonly ContractFile[];
}

/** Publish one complete package without overwriting an existing world. */
export async function writeWorldPackage(
  outputDir: string,
  world: GeneratedWorld,
  options: WriteWorldPackageOptions = {},
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
    const files = await writeWorldDataFiles(
      staging,
      manifest,
      packageContent,
      options.dataContracts,
    );
    await writeFile(
      path.join(staging, GENERATED_WORLD_MARKER),
      `${JSON.stringify({ schemaVersion: 1 })}\n`,
      "utf8",
    );
    // The main file is in the world's own language. A `WORLD.<locale>.md`
    // is a translation, and a new world has none.
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
      let removePrevious = true;
      try {
        try {
          await rename(staging, finalDir);
        } catch (error) {
          try {
            await rename(kept, finalDir);
          } catch (restoreError) {
            throw new WorldPackageRecoveryError(kept, [error, restoreError]);
          }
          throw error;
        }
        try {
          await options.afterPublish?.();
        } catch (error) {
          // Set the rejected package aside, then bring the old one back.
          try {
            await rename(finalDir, path.join(previous, "rejected"));
            await rename(kept, finalDir);
          } catch (restoreError) {
            console.error(
              `[world-writer] could not restore ${finalDir} from ${kept}:`,
              restoreError,
            );
            throw new WorldPackageRecoveryError(kept, [error, restoreError]);
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof WorldPackageRecoveryError) removePrevious = false;
        throw error;
      } finally {
        if (removePrevious)
          await rm(previous, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      // Concurrent creators race only at publication; a complete winner is
      // non-empty and cannot be replaced by the loser's directory rename.
      await rename(staging, finalDir);
    }
    return [...files, "world.yaml", "WORLD.md"].map((file) => `${id}/${file}`);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Write the structured data of a generated world, each kind to the path the
 * world conventions read it from. Returns the files written.
 */
export async function writeWorldDataFiles(
  worldDir: string,
  manifest: Record<string, unknown>,
  packageContent?: GeneratedWorldPackageContent,
  dataContracts: readonly ContractFile[] = [],
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

  const written: string[] = [];
  const sources: Record<string, Record<string, unknown>> = {};
  const write = async (file: string, kind: "yaml" | "json", value: unknown) => {
    const full = packageFile(worldDir, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(
      full,
      kind === "yaml"
        ? stringifyYaml(value, { lineWidth: 0 })
        : `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    written.push(file);
  };

  if (hasDimensions) {
    await write(GENERATED_DIMENSIONS_PATH, "yaml", inline);
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
    await write(GENERATED_CHARACTERS_PATH, "json", characters);
    sources.characters = {
      kind: "json",
      path: GENERATED_CHARACTERS_PATH,
      to: "characters",
      key: "id",
      ...(hasDimensions ? { after: "dimensions" } : {}),
    };
  }

  if (lorebook.length > 0) {
    await write(GENERATED_LOREBOOK_PATH, "yaml", lorebook);
    sources.lorebook = {
      kind: "yaml",
      path: GENERATED_LOREBOOK_PATH,
      to: "lorebook",
      key: "id",
      ...(hasDimensions ? { after: "dimensions" } : {}),
    };
  }

  // The records of one contract go into one file: the one its plugin names,
  // or `data/contract-<n>.json` with an entry in a descriptor. A named file
  // that another source of the package has is not this contract's: written
  // there, its records would replace the other's.
  const byContract = new Map<string, typeof contractData>();
  for (const record of contractData)
    byContract.set(record.contract, [
      ...(byContract.get(record.contract) ?? []),
      record,
    ]);
  const taken = new Set(RESERVED_PATHS.map(fileKey));
  const claim = (file: string): boolean => {
    const key = fileKey(file);
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  };
  let needsDescriptor = false;
  for (const [index, [contract, records]] of [...byContract].entries()) {
    const declared = dataContracts.find(
      (item) => item.contract === contract,
    )?.source;
    const named = declared && claim(declared.path) ? declared : undefined;
    let file = named?.path;
    for (let n = index; file === undefined; n++) {
      const generated = `data/contract-${n}.json`;
      if (claim(generated)) file = generated;
    }
    const kind = named?.kind ?? "json";
    if (!named) needsDescriptor = true;
    const values = records.map((record) => record.value);
    await write(file, kind, values.length === 1 ? values[0] : values);
    sources[`contract${index}`] = {
      kind,
      path: file,
      schema: `contract:${contract}`,
      to: `contract:${contract}${records[0]?.lorebook ? "+lorebook" : ""}`,
      key: "id",
      ...(declared?.localeArrayKeys
        ? { localeArrayKeys: [...declared.localeArrayKeys] }
        : {}),
    };
  }

  if (needsDescriptor) {
    await write(GENERATED_WORLD_DATA_PATH, "yaml", {
      schemaVersion: 1,
      sources,
    });
    manifest.worldData = GENERATED_WORLD_DATA_PATH;
  }

  return written;
}
