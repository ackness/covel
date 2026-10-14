/**
 * World package file writing.
 *
 * A generated world is laid out as a hand-authored one: each file at the path
 * the world conventions give it, in one language. A package whose files are
 * all at such paths has no descriptor; one is written only for records of a
 * contract with no path of its own: its plugin names none, or names one that
 * another source has.
 */

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
 * A file that says this package was written by the generator, and lists each
 * file the app wrote with a hash of its content. While the package holds
 * exactly those files it can be written again from a revised world. A file
 * that is not in the list, or whose content differs from its hash, is a
 * person's work that a rewrite would lose: such a package is not rewritten.
 * A package made by hand or installed from elsewhere has no marker.
 */
export const GENERATED_WORLD_MARKER = ".covel-generated.json";

const GENERATED_WORLD_MARKER_VERSION = 2;

/** What the marker file holds: package path (with `/`) to SHA-256 of the file. */
export interface GeneratedWorldMarker {
  readonly schemaVersion: typeof GENERATED_WORLD_MARKER_VERSION;
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Whether the app may rewrite a package:
 * - `unmarked`: not written by the generator (no marker, or one without the
 *   file list).
 * - `pristine`: every file is one the app wrote, unchanged.
 * - `modified`: `added` files are not in the marker's list and `changed`
 *   ones differ from what the app wrote. A listed file that is gone is
 *   neither: a rewrite loses nothing of it.
 */
export type GeneratedWorldPackageState =
  | { readonly state: "unmarked" }
  | { readonly state: "pristine" }
  | {
      readonly state: "modified";
      readonly added: readonly string[];
      readonly changed: readonly string[];
    };

/** A rewrite was refused: the package holds a person's files or edits. */
export class WorldPackageModifiedError extends Error {
  constructor(
    readonly added: readonly string[],
    readonly changed: readonly string[],
  ) {
    const files = [...added, ...changed];
    super(
      `World package has files that were added or changed by hand: ${files
        .slice(0, 5)
        .join(
          ", ",
        )}${files.length > 5 ? ` and ${files.length - 5} more` : ""}. Revising would rewrite the whole package and lose them; edit the files of the package instead, or undo those changes first`,
    );
    this.name = "WorldPackageModifiedError";
  }
}

/** Files a desktop leaves in a folder that is opened; nobody's work. */
const OS_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** Every file of a package but the marker, as package paths with `/`. */
async function packageFilePaths(worldDir: string): Promise<string[]> {
  const entries = await readdir(worldDir, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => !entry.isDirectory() && !OS_FILES.has(entry.name))
    .map((entry) =>
      path
        .relative(worldDir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .filter((file) => file !== GENERATED_WORLD_MARKER)
    .sort();
}

/** A link is hashed by its target path: what it points at is not followed. */
async function fileHash(worldDir: string, file: string): Promise<string> {
  const full = path.join(worldDir, file);
  const content = (await lstat(full)).isSymbolicLink()
    ? `link:${await readlink(full)}`
    : await readFile(full);
  return createHash("sha256").update(content).digest("hex");
}

async function writeMarker(
  worldDir: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const marker: GeneratedWorldMarker = {
    schemaVersion: GENERATED_WORLD_MARKER_VERSION,
    files: Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
  await writeFile(
    path.join(worldDir, GENERATED_WORLD_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
}

/**
 * The marker of a generated package, or `null` for a package without one. A
 * marker that is not in the current form (no file list) counts as none:
 * nothing says which files of that package the generator wrote.
 */
export async function readGeneratedWorldMarker(
  worldDir: string,
): Promise<GeneratedWorldMarker | null> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(path.join(worldDir, GENERATED_WORLD_MARKER), "utf8"),
    );
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return null;
    throw error;
  }
  if (!value || typeof value !== "object") return null;
  const { schemaVersion, files } = value as Record<string, unknown>;
  if (
    schemaVersion !== GENERATED_WORLD_MARKER_VERSION ||
    !files ||
    typeof files !== "object" ||
    Array.isArray(files) ||
    !Object.values(files).every((hash) => typeof hash === "string")
  )
    return null;
  return {
    schemaVersion: GENERATED_WORLD_MARKER_VERSION,
    files: files as Record<string, string>,
  };
}

/** Compare a package with the files its marker lists. */
export async function inspectGeneratedWorldPackage(
  worldDir: string,
): Promise<GeneratedWorldPackageState> {
  const marker = await readGeneratedWorldMarker(worldDir);
  if (!marker) return { state: "unmarked" };
  const added: string[] = [];
  const changed: string[] = [];
  for (const file of await packageFilePaths(worldDir)) {
    const recorded = Object.hasOwn(marker.files, file)
      ? marker.files[file]
      : undefined;
    if (recorded === undefined) added.push(file);
    else if (recorded !== (await fileHash(worldDir, file))) changed.push(file);
  }
  return added.length === 0 && changed.length === 0
    ? { state: "pristine" }
    : { state: "modified", added, changed };
}

/**
 * Add files that the app itself wrote into a generated package (a
 * translation, say) to the marker's list, with their content as it is now.
 * Call it only for a package that was `pristine` before the write: it would
 * take a person's edit of such a file for the app's own. Does nothing for a
 * package without a marker.
 */
export async function recordGeneratedWorldFiles(
  worldDir: string,
  files: readonly string[],
): Promise<void> {
  const marker = await readGeneratedWorldMarker(worldDir);
  if (!marker) return;
  const recorded = { ...marker.files };
  for (const file of files) {
    const key = path.posix.normalize(file.replaceAll("\\", "/"));
    recorded[key] = await fileHash(worldDir, key);
  }
  await writeMarker(worldDir, recorded);
}

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
   * Only a generated package that holds nothing but what the app wrote is
   * replaced: one with a person's files or edits is refused with a
   * `WorldPackageModifiedError`. The old directory is kept until the new one
   * is in place, so a failure leaves the old package as it was.
   */
  readonly replace?: boolean;
  /**
   * Runs once the new package is in place, before the old one
   * is dropped. If it throws, the old package is put back and the error is
   * rethrown, so the caller can tie the swap to its own read-back and record
   * update.
   */
  readonly afterPublish?: () => Promise<void>;
  /** Validate the complete staging directory before publishing any files. */
  readonly beforePublish?: (staging: string) => Promise<void>;
  /** The contracts the world was generated with; each may name its file. */
  readonly dataContracts?: readonly ContractFile[];
}

/** Publish a fully prepared sibling directory; restore the old package on failure.
 * Callers serialize publication and validate their current package before calling.
 */
export async function publishWorldPackage(
  staging: string,
  finalDir: string,
  options: { replace?: boolean; afterPublish?: () => Promise<void> } = {},
): Promise<void> {
  const { afterPublish } = options;
  if (options.replace) {
    const previous = await mkdtemp(
      path.join(path.dirname(finalDir), ".covel-replaced-"),
    );
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
        await afterPublish?.();
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
    // A complete concurrent winner is non-empty and cannot be overwritten.
    await rename(staging, finalDir);
    try {
      await afterPublish?.();
    } catch (error) {
      await rm(finalDir, { recursive: true, force: true });
      throw error;
    }
  }
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
    // The main file is in the world's own language. A `WORLD.<locale>.md`
    // is a translation, and a new world has none.
    await writeFile(path.join(staging, "WORLD.md"), lore, "utf8");
    await writeFile(
      path.join(staging, "world.yaml"),
      stringifyYaml(manifest, { lineWidth: 0 }),
      "utf8",
    );
    // Every file of the package is written by now; the marker lists them all.
    const written: Record<string, string> = {};
    for (const file of await packageFilePaths(staging))
      written[file] = await fileHash(staging, file);
    await writeMarker(staging, written);
    await options.beforePublish?.(staging);
    if (options.replace) {
      // Checked last, just before the swap: the model ran for a while, and a
      // person may have put a file into the package in that time.
      const current = await inspectGeneratedWorldPackage(finalDir);
      if (current.state === "unmarked")
        throw new Error(
          `World package was not written by the generator: ${id}`,
        );
      if (current.state === "modified")
        throw new WorldPackageModifiedError(current.added, current.changed);
    }
    await publishWorldPackage(staging, finalDir, options);
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
