import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export const INSTALL_STAGING_PREFIX = ".covel-install-";
const UNINSTALL_STAGING_PREFIX = ".covel-uninstall-";
export const WORLD_DELETE_STAGING_PREFIX = ".covel-world-delete-";

/** Only immediate real directories belong to the staging area; never follow links. */
export async function listPackageStaging(
  root: string,
  prefixes: readonly string[],
): Promise<string[]> {
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    return (await readdir(root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          prefixes.some((prefix) => entry.name.startsWith(prefix)),
      )
      .map((entry) => path.join(root, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(`[package-staging] Could not scan ${root}:`, error);
    return [];
  }
}

/** After logical removal, cleanup failures must not put a partial package back. */
export async function removePackageStaging(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch((error) => {
    console.warn(`[package-staging] Could not remove ${directory}:`, error);
  });
}

/** Move the whole package out of discovery before deleting any of its files. */
export async function stagePackageRemoval(
  packagePath: string,
  prefix = UNINSTALL_STAGING_PREFIX,
): Promise<{ directory: string; stagedPackage: string }> {
  const directory = await mkdtemp(path.join(path.dirname(packagePath), prefix));
  const stagedPackage = path.join(directory, "package");
  try {
    await rename(packagePath, stagedPackage);
  } catch (error) {
    await removePackageStaging(directory);
    throw error;
  }
  return { directory, stagedPackage };
}

/** Mark a committed world deletion as disposable before recursive cleanup starts. */
export async function discardWorldDeletion(directory: string): Promise<void> {
  const discarded = path.join(
    path.dirname(directory),
    `${UNINSTALL_STAGING_PREFIX}${randomUUID()}`,
  );
  try {
    await rename(directory, discarded);
    await removePackageStaging(discarded);
  } catch (error) {
    console.warn(
      `[package-staging] Could not finish deletion ${directory}:`,
      error,
    );
  }
}

/** Startup only, before routes/watchers/imports can create or use staging files. */
export async function cleanupPackageStaging(root: string): Promise<void> {
  for (const directory of await listPackageStaging(root, [
    INSTALL_STAGING_PREFIX,
    UNINSTALL_STAGING_PREFIX,
  ]))
    await removePackageStaging(directory);
  // Named update transactions (including their recovery backups) are retained.
  for (const directory of await listPackageStaging(
    path.join(root, ".covel-updates"),
    [INSTALL_STAGING_PREFIX],
  ))
    await removePackageStaging(directory);
}
