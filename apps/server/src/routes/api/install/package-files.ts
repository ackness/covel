import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { githubPluginSourceSchema, pluginInstallIdSchema } from "@covel/shared";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import { digestEntries } from "./github-source.js";
import { httpError, LIMITS, type ExtractedEntry } from "./shared.js";

export const receiptFile = ".covel-install.json";
export const packageReceiptSchema = z
  .object({
    source: githubPluginSourceSchema,
    version: z.string().nullable(),
    installedAt: z.iso.datetime(),
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
        await readRegularFile(path.join(directory, receiptFile), 16 * 1024)
      ).toString("utf8"),
    ),
  );
}

// Read without importing modules. Detect local edits, extra data, links, and
// deleted files before an update can replace any package directory.
export async function readPackageFiles(
  directory: string,
): Promise<ExtractedEntry[]> {
  await assertPackageDirectory(directory);
  const entries: ExtractedEntry[] = [];
  let bytes = 0;
  let count = 0;
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      if (++count > LIMITS.maxEntries)
        throw httpError(409, "Package contains too many local files");
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (name === receiptFile) continue;
      const absolute = path.join(directory, name);
      if (entry.isDirectory()) {
        await assertPackageDirectory(absolute);
        await visit(name);
      } else {
        if (!entry.isFile())
          throw httpError(
            409,
            "Package contains linked or unsupported local files",
          );
        const content = await readRegularFile(
          absolute,
          LIMITS.maxUncompressedBytes - bytes,
        );
        bytes += content.length;
        entries.push({ relativePath: name, content });
      }
    }
  };
  await visit("");
  return entries;
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
