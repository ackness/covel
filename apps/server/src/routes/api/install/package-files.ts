import {
  PackageInventoryError,
  readPackageInventory,
  type PackageFile,
} from "@covel/plugin-loader";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  githubPluginSourceSchema,
  pluginInstallIdSchema,
  pluginCapabilitiesSchema,
  type PackageIntegrity,
} from "@covel/shared";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import { digestEntries } from "./github-source.js";
import {
  httpError,
  INSTALL_RECEIPT_FILE,
  LIMITS,
  type ExtractedEntry,
} from "./shared.js";

export const packageReceiptSchema = z
  .object({
    source: githubPluginSourceSchema,
    version: z.string().nullable(),
    installedAt: z.iso.datetime(),
    capabilities: pluginCapabilitiesSchema.optional(),
  })
  .strict();
export type PackageReceipt = z.infer<typeof packageReceiptSchema>;
const mutations = new Set<string>();

// Install, queue/cancel update, and uninstall share one admission boundary.
export async function withPackageMutation<T>(
  id: string,
  action: () => Promise<T>,
  root = resolveUserResourceDirs().plugins,
): Promise<T> {
  pluginInstallIdSchema.parse(id);
  const key = path.join(root, id);
  if (mutations.has(key))
    throw httpError(
      409,
      "Another operation is changing this package; try again",
    );
  mutations.add(key);
  try {
    return await action();
  } finally {
    mutations.delete(key);
  }
}

export async function readRegularFile(
  filename: string,
  maxBytes = LIMITS.maxUncompressedBytes,
): Promise<Buffer> {
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw httpError(
        409,
        "Package files contain an unsupported file or exceed the size limit",
      );
    const content = await handle.readFile();
    if (content.length > maxBytes)
      throw httpError(409, "Package file exceeds the size limit");
    return content;
  } finally {
    await handle.close();
  }
}

export async function assertPackageDirectory(directory: string) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw httpError(
      409,
      "Linked or non-directory package paths cannot be updated",
    );
}

export async function readReceipt(directory: string): Promise<PackageReceipt> {
  await assertPackageDirectory(directory);
  return packageReceiptSchema.parse(
    JSON.parse(
      (
        await readRegularFile(
          path.join(directory, INSTALL_RECEIPT_FILE),
          1024 * 1024,
        )
      ).toString("utf8"),
    ),
  );
}

// Read without importing modules. Detect local edits, extra data, links, and
// deleted files before an update can replace any package directory.
async function readPackageFiles(directory: string): Promise<ExtractedEntry[]> {
  try {
    const { files } = await readPackageInventory(directory);
    return files.map((file) => ({
      relativePath: file.relativePath,
      content: Buffer.from(file.content),
    }));
  } catch (error) {
    if (
      error instanceof PackageInventoryError ||
      (error as NodeJS.ErrnoException).code === "ELOOP"
    )
      throw httpError(
        409,
        "Package contents are unsupported, exceed limits, or changed during inspection",
      );
    throw error;
  }
}

export async function readUnmodifiedPackage(
  directory: string,
  expected?: PackageReceipt,
) {
  const receipt = await readReceipt(directory);
  if (expected && JSON.stringify(receipt) !== JSON.stringify(expected))
    throw httpError(409, "Installed package changed; check for updates again");
  const entries = await readPackageFiles(directory);
  if (digestEntries(entries) !== receipt.source.digest)
    throw httpError(
      409,
      "Package files were modified locally; back up and resolve local changes before updating",
    );
  return { receipt, entries };
}

export interface PackageIntegrityResult {
  status: PackageIntegrity;
  receipt?: PackageReceipt;
  files?: string[];
}
/** Receipt metadata is excluded from the content digest, just as at install. */
export async function checkPackageIntegrity(
  directory: string,
  inspected?: readonly PackageFile[],
): Promise<PackageIntegrityResult> {
  let receipt: PackageReceipt;
  try {
    await assertPackageDirectory(directory);
    try {
      await lstat(path.join(directory, INSTALL_RECEIPT_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { status: "no-receipt" };
      throw error;
    }
    receipt = await readReceipt(directory);
  } catch {
    return { status: "unreadable" };
  }
  try {
    const entries = inspected
      ? inspected.map((file) => ({
          relativePath: file.relativePath,
          content: Buffer.from(file.content),
        }))
      : await readPackageFiles(directory);
    return {
      status:
        digestEntries(entries) === receipt.source.digest
          ? "verified"
          : "modified",
      receipt,
      files: entries.map((entry) => entry.relativePath).sort(),
    };
  } catch (error) {
    // Unsupported files/links and files removed during traversal are edits.
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status:
        (error as { httpStatus?: number }).httpStatus === 409 ||
        code === "ENOENT" ||
        code === "ELOOP"
          ? "modified"
          : "unreadable",
      receipt,
    };
  }
}
