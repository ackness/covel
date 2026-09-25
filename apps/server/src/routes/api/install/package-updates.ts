import { lstat, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pluginInstallIdSchema } from "@covel/shared";
import {
  assertPackageDirectory,
  packageReceiptSchema,
  readRegularFile,
  readUnmodifiedPackage,
  withPackageMutation,
  type PackageReceipt,
} from "./package-files.js";
import {
  httpError,
  materializeEntries,
  type ExtractedEntry,
} from "./shared.js";

const planSchema = z
  .object({ previous: packageReceiptSchema, next: packageReceiptSchema })
  .strict();
const updatesDir = ".covel-updates";
export const pendingPackagePath = (root: string, id: string) =>
  path.join(root, updatesDir, pluginInstallIdSchema.parse(id));
const exists = (filename: string) =>
  lstat(filename).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

async function readPlan(root: string, id: string) {
  const directory = pendingPackagePath(root, id);
  await assertPackageDirectory(path.dirname(directory));
  await assertPackageDirectory(directory);
  return planSchema.parse(
    JSON.parse(
      (
        await readRegularFile(path.join(directory, "plan.json"), 32 * 1024)
      ).toString("utf8"),
    ),
  );
}

export async function pendingPackageUpdate(root: string, id: string) {
  if (!(await exists(pendingPackagePath(root, id)))) return null;
  const plan = await readPlan(root, id);
  const errorPath = path.join(pendingPackagePath(root, id), "error.txt");
  const error = (await exists(errorPath))
    ? (await readRegularFile(errorPath, 16 * 1024)).toString("utf8")
    : null;
  return { version: plan.next.version, source: plan.next.source, error };
}

export async function queuePackageUpdate(
  root: string,
  id: string,
  previous: PackageReceipt,
  next: PackageReceipt,
  entries: readonly ExtractedEntry[],
) {
  await withPackageMutation(
    id,
    async () => {
      await readUnmodifiedPackage(path.join(root, id), previous);
      const parent = path.join(root, updatesDir);
      if (await exists(parent)) await assertPackageDirectory(parent);
      await materializeEntries(pendingPackagePath(root, id), [
        {
          relativePath: "plan.json",
          content: Buffer.from(JSON.stringify({ previous, next })),
        },
        ...entries.map((entry) => ({
          ...entry,
          relativePath: `package/${entry.relativePath}`,
        })),
      ]);
    },
    root,
  );
}

// Caller holds the same mutation lock as uninstall. Never remove a recovery
// backup: that means a startup transaction was interrupted and must recover.
export async function cancelPackageUpdate(root: string, id: string) {
  const directory = pendingPackagePath(root, id);
  if (!(await exists(directory))) return;
  await readPlan(root, id);
  if (await exists(path.join(directory, "previous")))
    throw httpError(
      409,
      "An interrupted update needs backend restart recovery before removal",
    );
  await rm(directory, { recursive: true });
}

// Run before plugin discovery/imports. Running backends keep all old files;
// fresh process approval gates cannot inherit the previous code's grants.
export async function applyPendingPackageUpdates(
  root: string,
  beforeApply?: (id: string) => Promise<void>,
): Promise<void> {
  const parent = path.join(root, updatesDir);
  if (!(await exists(parent))) return;
  await assertPackageDirectory(parent);
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !pluginInstallIdSchema.safeParse(entry.name).success
    )
      continue;
    const id = entry.name;
    const directory = pendingPackagePath(root, id);
    const target = path.join(root, id);
    const backup = path.join(directory, "previous");
    const candidate = path.join(directory, "package");
    try {
      await withPackageMutation(
        id,
        async () => {
          const plan = await readPlan(root, id);
          if (await exists(backup)) {
            if (await exists(target)) {
              // Crash after promotion, before cleanup: recognize only the exact
              // approved package. Ambiguous state must retain both directories.
              await readUnmodifiedPackage(target, plan.next);
              await rm(directory, { recursive: true });
              return;
            }
            await rename(backup, target);
          }
          await beforeApply?.(id);
          await readUnmodifiedPackage(target, plan.previous);
          await readUnmodifiedPackage(candidate, plan.next);
          await rename(target, backup);
          try {
            await rename(candidate, target);
          } catch (error) {
            await rename(backup, target);
            throw error;
          }
          await rm(directory, { recursive: true });
        },
        root,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to apply package update";
      console.warn(`[package-update] ${id}: ${message}`);
      // If restoration failed, do not boot with a missing/ambiguous package.
      if (await exists(backup))
        throw new Error(`Package update recovery requires attention: ${id}`, {
          cause: error,
        });
      await writeFile(
        path.join(directory, "error.txt"),
        message.slice(0, 8000),
      ).catch(() => undefined);
    }
  }
}
