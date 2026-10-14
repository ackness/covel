import { lstat, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { DataStore, WorldRecord } from "@covel/store";
import { findWorldPackageRoots } from "../../../world-data/session-import/utils.js";
import { SAFE_WORLD_ID_RE } from "../../../lib/validators.js";
import {
  readWorldDeletion,
  WORLD_DELETION_KEY,
} from "../../../world-lifecycle.js";
import {
  assertPackageDirectory,
  readRegularFile,
} from "../install/package-files.js";
import {
  discardWorldDeletion,
  listPackageStaging,
  removePackageStaging,
  stagePackageRemoval,
  WORLD_DELETE_STAGING_PREFIX,
} from "../install/package-staging.js";

export class WorldPackageResolutionError extends Error {}

/** Keep the package recoverable until the database deletion succeeds. */
export async function deleteWorldPackage(
  worldPath: string,
  deleteRecord: () => Promise<void>,
): Promise<void> {
  const { directory: stagingDir, stagedPackage } = await stagePackageRemoval(
    worldPath,
    WORLD_DELETE_STAGING_PREFIX,
  );
  try {
    await deleteRecord();
  } catch (error) {
    try {
      await rename(stagedPackage, worldPath);
    } catch (restoreError) {
      // Preserve the staged files for recovery if the original path is blocked.
      throw new AggregateError(
        [error, restoreError],
        `World deletion failed; package retained in ${stagedPackage}`,
      );
    }
    await removePackageStaging(stagingDir);
    throw error;
  }
  // The logical deletion is committed. Failed cleanup must not resurrect it.
  await discardWorldDeletion(stagingDir);
}

const recoveryManifestSchema = z.object({
  id: z.string().regex(SAFE_WORLD_ID_RE),
});

/** Startup only: settle the filesystem half of an interrupted world deletion. */
export async function recoverWorldPackageDeletions(
  store: DataStore,
  root: string,
): Promise<void> {
  for (const directory of await listPackageStaging(root, [
    WORLD_DELETE_STAGING_PREFIX,
  ])) {
    const stagedPackage = path.join(directory, "package");
    try {
      const staged = await lstat(stagedPackage).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (!staged) {
        // Interrupted before staging or after restoration; there is no package here.
        await removePackageStaging(directory);
        continue;
      }
      await assertPackageDirectory(stagedPackage);
      const { id } = recoveryManifestSchema.parse(
        parseYaml(
          (
            await readRegularFile(path.join(stagedPackage, "world.yaml"))
          ).toString("utf8"),
        ),
      );
      const world = await store.getWorld(id);
      if (!world) {
        await discardWorldDeletion(directory);
        continue;
      }
      const deletion = readWorldDeletion(world);
      if (!deletion || world.metadata?.source !== "generated-file")
        throw new Error("World is not awaiting package deletion");
      const storage = world.metadata.storage;
      if (
        storage !== undefined &&
        (!storage ||
          typeof storage !== "object" ||
          !("path" in storage) ||
          typeof storage.path !== "string" ||
          (await realpath(storage.path)) !== (await realpath(root)))
      )
        throw new Error(
          "World storage binding does not match the staged package",
        );
      const target = path.join(root, id);
      const occupied = await lstat(target).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (occupied || (await findWorldPackageRoots(id, root)).length > 0)
        throw new Error(
          "World package restoration would conflict with an existing package",
        );
      // Keep the deletion marker: sessions may already be gone. A retry resumes
      // the normal lifecycle immediately rather than waiting for its old lease.
      await store.upsertWorld({
        ...world,
        metadata: {
          ...world.metadata,
          [WORLD_DELETION_KEY]: { ...deletion, retryable: true },
        },
      });
      await rename(stagedPackage, target);
      await removePackageStaging(directory);
    } catch (error) {
      // Ambiguous state or an unavailable DB must retain every file and not block boot.
      console.warn(
        `[world-delete] Could not recover ${directory}; retained for retry:`,
        error,
      );
    }
  }
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
