import { realpath } from "node:fs/promises";
import type { WorldRecord } from "@covel/store";
import { findWorldPackageRoots } from "../../../world-data/session-import/utils.js";

export class WorldPackageResolutionError extends Error {}

/** Resolve the owned package before any deletion; never guess across roots. */
export async function resolveGeneratedWorldPackage(
  world: WorldRecord,
  worldsDirs: readonly string[],
): Promise<string> {
  const roots = new Set<string>();
  for (const root of worldsDirs) {
    try {
      roots.add(await realpath(root));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const storage = world.metadata?.storage;
  if (storage !== undefined) {
    if (
      !storage ||
      typeof storage !== "object" ||
      !("path" in storage) ||
      typeof storage.path !== "string"
    ) {
      throw new WorldPackageResolutionError("World storage binding is invalid");
    }
    let boundRoot: string;
    try {
      boundRoot = await realpath(storage.path);
    } catch {
      throw new WorldPackageResolutionError(
        "World storage directory is unavailable",
      );
    }
    if (!roots.has(boundRoot)) {
      throw new WorldPackageResolutionError(
        "World storage directory is not configured",
      );
    }
    roots.clear();
    roots.add(boundRoot);
  }
  const matches: string[] = [];
  for (const root of roots) {
    matches.push(...(await findWorldPackageRoots(world.id, root)));
  }
  if (matches.length !== 1) {
    throw new WorldPackageResolutionError(
      "World package is missing or ambiguous",
    );
  }
  return matches[0]!;
}
