import { lstat, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pluginInstallIdSchema } from "@covel/shared";
import {
  assertPluginDirectory,
  pluginReceiptSchema,
  readRegularFile,
  readUnmodifiedPlugin,
  withPluginMutation,
  type PluginReceipt,
} from "./plugin-files.js";
import {
  httpError,
  materializeEntries,
  type ExtractedEntry,
} from "./shared.js";

const planSchema = z
  .object({ previous: pluginReceiptSchema, next: pluginReceiptSchema })
  .strict();
const updatesDir = ".covel-updates";
export const pendingPluginPath = (root: string, id: string) =>
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
  const directory = pendingPluginPath(root, id);
  await assertPluginDirectory(path.dirname(directory));
  await assertPluginDirectory(directory);
  return planSchema.parse(
    JSON.parse(
      (
        await readRegularFile(path.join(directory, "plan.json"), 32 * 1024)
      ).toString("utf8"),
    ),
  );
}

export async function pendingPluginUpdate(root: string, id: string) {
  if (!(await exists(pendingPluginPath(root, id)))) return null;
  const plan = await readPlan(root, id);
  const errorPath = path.join(pendingPluginPath(root, id), "error.txt");
  const error = (await exists(errorPath))
    ? (await readRegularFile(errorPath, 16 * 1024)).toString("utf8")
    : null;
  return { version: plan.next.version, source: plan.next.source, error };
}

export async function queuePluginUpdate(
  root: string,
  id: string,
  previous: PluginReceipt,
  next: PluginReceipt,
  entries: readonly ExtractedEntry[],
) {
  await withPluginMutation(
    id,
    async () => {
      await readUnmodifiedPlugin(path.join(root, id), previous);
      const parent = path.join(root, updatesDir);
      if (await exists(parent)) await assertPluginDirectory(parent);
      await materializeEntries(pendingPluginPath(root, id), [
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
export async function cancelPluginUpdate(root: string, id: string) {
  const directory = pendingPluginPath(root, id);
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
export async function applyPendingPluginUpdates(root: string): Promise<void> {
  const parent = path.join(root, updatesDir);
  if (!(await exists(parent))) return;
  await assertPluginDirectory(parent);
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !pluginInstallIdSchema.safeParse(entry.name).success
    )
      continue;
    const id = entry.name;
    const directory = pendingPluginPath(root, id);
    const target = path.join(root, id);
    const backup = path.join(directory, "previous");
    const candidate = path.join(directory, "package");
    try {
      await withPluginMutation(
        id,
        async () => {
          const plan = await readPlan(root, id);
          if (await exists(backup)) {
            if (await exists(target)) {
              // Crash after promotion, before cleanup: recognize only the exact
              // approved package. Ambiguous state must retain both directories.
              await readUnmodifiedPlugin(target, plan.next);
              await rm(directory, { recursive: true });
              return;
            }
            await rename(backup, target);
          }
          await readUnmodifiedPlugin(target, plan.previous);
          await readUnmodifiedPlugin(candidate, plan.next);
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
          : "Unable to apply plugin update";
      console.warn(`[plugin-update] ${id}: ${message}`);
      // If restoration failed, do not boot with a missing/ambiguous package.
      if (await exists(backup))
        throw new Error(`Plugin update recovery requires attention: ${id}`, {
          cause: error,
        });
      await writeFile(
        path.join(directory, "error.txt"),
        message.slice(0, 8000),
      ).catch(() => undefined);
    }
  }
}
