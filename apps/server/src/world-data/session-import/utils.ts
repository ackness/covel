import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { readWorldManifestSource } from "../locale-overlays.js";
import { resolveContainedPath } from "../safe-path.js";
import type { OrderedWorldDataSource } from "../types.js";

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sourceItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** What a diagnostic about one record of a source says about its place. */
export interface RecordLocation {
  /** Names the record in a message: `record [2] (id "gate")`. */
  readonly label: string;
  /** The source file, relative to the world directory. */
  readonly path?: string;
  /** The record's place in the file, such as `[2]`. */
  readonly pointer?: string;
}

/**
 * Name one record of a source for a diagnostic: its file, its place in the
 * file and its key. `listed` says that the file holds a list of records.
 */
export function recordLocation(
  source: OrderedWorldDataSource,
  value: unknown,
  index: number,
  listed: boolean,
): RecordLocation {
  const keyField = source.descriptor.key;
  const key = keyField && isRecord(value) ? value[keyField] : undefined;
  const named =
    typeof key === "string" || typeof key === "number"
      ? ` (${keyField} "${key}")`
      : "";
  return {
    label: listed
      ? `record [${index}]${named}`
      : typeof value === "string"
        ? "the text"
        : `the record${named}`,
    // A record that was not read from a file has no path to name.
    ...(source.inlineValue === undefined
      ? { path: source.descriptor.path }
      : {}),
    ...(listed ? { pointer: `[${index}]` } : {}),
  };
}

export async function readWorldManifest(worldRoot: string): Promise<{
  id?: string;
  worldData?: string;
  dimensions?: unknown;
  dimensionSources?: unknown;
  characterSchema?: unknown;
  defaultLocale?: string;
  themeMusic?: string;
}> {
  // `world.<locale>.yaml` overlays are compiled in, as the world loader does.
  const { raw } = await readWorldManifestSource(worldRoot);
  return isRecord(raw)
    ? {
        id: typeof raw.id === "string" ? raw.id : undefined,
        dimensions: raw.dimensions,
        dimensionSources: raw.dimensionSources,
        characterSchema: raw.characterSchema,
        defaultLocale:
          typeof raw.defaultLocale === "string" ? raw.defaultLocale : undefined,
        worldData:
          typeof raw.worldData === "string" ? raw.worldData : undefined,
        themeMusic:
          typeof raw.themeMusic === "string" ? raw.themeMusic : undefined,
      }
    : {};
}

export async function resolveWorldRoot(
  worldId: string,
  worldsDirs: readonly string[],
): Promise<string | null> {
  for (const worldsDir of [...worldsDirs].reverse()) {
    const matches = await findWorldPackageRoots(worldId, worldsDir);
    if (matches.length > 1) {
      throw new Error(
        `Multiple world packages declare id "${worldId}" in one root`,
      );
    }
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}

/** Locate immediate packages by manifest identity, excluding symlinked packages/manifests. */
export async function findWorldPackageRoots(
  worldId: string,
  worldsDir: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(worldsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const worldDir = path.join(worldsDir, entry.name);
    const manifestPath = await resolveContainedPath(worldDir, "world.yaml", {
      rejectSymlinks: true,
    });
    if (!manifestPath) continue;
    try {
      const manifest = await readWorldManifest(path.dirname(manifestPath));
      if (manifest.id === worldId) matches.push(path.dirname(manifestPath));
    } catch (error) {
      // One malformed neighboring package must not disable healthy worlds.
      console.warn(
        `[world-data] Cannot read world manifest in ${entry.name}:`,
        error,
      );
    }
  }
  return matches;
}
