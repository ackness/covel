import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveContainedPath } from "../safe-path.js";

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

export async function readWorldManifest(worldRoot: string): Promise<{
  id?: string;
  worldData?: string;
}> {
  const raw = parseYaml(
    await readFile(path.join(worldRoot, "world.yaml"), "utf-8"),
  );
  return isRecord(raw)
    ? {
        id: typeof raw.id === "string" ? raw.id : undefined,
        worldData:
          typeof raw.worldData === "string" ? raw.worldData : undefined,
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
    if (!entry.isDirectory()) continue;
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
