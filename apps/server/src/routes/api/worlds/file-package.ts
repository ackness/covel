import { mkdtemp, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { WorldRecord } from "@covel/store";
import { findWorldPackageRoots } from "../../../world-data/session-import/utils.js";

export class WorldPackageResolutionError extends Error {}

/** Keep the package recoverable until the database deletion succeeds. */
export async function deleteWorldPackage(
  worldPath: string,
  deleteRecord: () => Promise<void>,
): Promise<void> {
  // A container without world.yaml cannot be rediscovered as a world package.
  const stagingDir = await mkdtemp(
    path.join(path.dirname(worldPath), ".covel-world-delete-"),
  );
  const stagedPackage = path.join(stagingDir, "package");
  let staged = false;
  try {
    await rename(worldPath, stagedPackage);
    staged = true;
    await deleteRecord();
  } catch (error) {
    if (staged) {
      try {
        await rename(stagedPackage, worldPath);
      } catch (restoreError) {
        // Preserve the staged files for recovery if the original path is blocked.
        throw new AggregateError(
          [error, restoreError],
          `World deletion failed; package retained in ${stagedPackage}`,
        );
      }
    }
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // The logical deletion is committed. Failed cleanup must not resurrect it.
  await rm(stagingDir, { recursive: true, force: true }).catch((error) => {
    console.warn("[world-delete] Could not remove staged package:", error);
  });
}

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
