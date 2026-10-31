import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

export const PACKAGE_INVENTORY_LIMITS = {
  maxEntries: 2000,
  maxBytes: 200 * 1024 * 1024,
} as const;

export interface PackageFile {
  readonly relativePath: string;
  readonly content: Uint8Array;
}

/** Unsupported, oversized or changing content cannot establish an inventory. */
export class PackageInventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageInventoryError";
  }
}

/** Receipt metadata is provenance, not executable package content. */
const receiptName = ".covel-install.json";

export function packageContentDigest(files: readonly PackageFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  )) {
    hash.update(JSON.stringify([file.relativePath, file.content.byteLength]));
    hash.update(file.content);
  }
  return hash.digest("hex");
}

/** Bounded change detection; never traverse links, including junctions. */
export async function packageFileSignature(directory: string): Promise<string> {
  const entries: string[] = [];
  async function visit(relative: string): Promise<void> {
    if (entries.length >= PACKAGE_INVENTORY_LIMITS.maxEntries)
      throw new PackageInventoryError("Package contains too many files");
    const absolute = path.join(directory, relative);
    const stat = await lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new PackageInventoryError(
        "Package contains linked or unsupported files",
      );
    if (!relative && !stat.isDirectory())
      throw new PackageInventoryError("Package root is not a directory");
    entries.push(
      JSON.stringify([
        relative,
        String(stat.mode),
        String(stat.size),
        String(stat.mtimeNs),
        String(stat.ctimeNs),
        String(stat.ino),
      ]),
    );
    if (stat.isDirectory())
      for (const name of (await readdir(absolute)).sort()) {
        if (!relative && name === receiptName) continue;
        await visit(relative ? `${relative}/${name}` : name);
      }
  }
  await visit("");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/** A complete regular-file inventory, independent of any installation receipt. */
export async function readPackageInventory(directory: string): Promise<{
  files: PackageFile[];
  directories: string[];
  signature: string;
  digest: string;
}> {
  const signature = await packageFileSignature(directory);
  const files: PackageFile[] = [];
  const directories: string[] = [];
  let bytes = 0;
  let count = 0;
  async function visit(relative: string): Promise<void> {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      if (++count > PACKAGE_INVENTORY_LIMITS.maxEntries)
        throw new PackageInventoryError("Package contains too many files");
      if (!relative && name === receiptName) continue;
      const relativePath = relative ? `${relative}/${name}` : name;
      const absolute = path.join(directory, relativePath);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink())
        throw new PackageInventoryError("Package contains linked files");
      if (stat.isDirectory()) {
        directories.push(relativePath);
        await visit(relativePath);
        continue;
      }
      if (
        !stat.isFile() ||
        stat.size > PACKAGE_INVENTORY_LIMITS.maxBytes - bytes
      )
        throw new PackageInventoryError(
          "Package contains unsupported files or exceeds the size limit",
        );
      const handle = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.size !== stat.size ||
          opened.ino !== stat.ino
        )
          throw new PackageInventoryError("Package changed during inspection");
        const content = await handle.readFile();
        bytes += content.byteLength;
        if (
          bytes > PACKAGE_INVENTORY_LIMITS.maxBytes ||
          content.byteLength !== stat.size
        )
          throw new PackageInventoryError(
            "Package changed or exceeds the size limit",
          );
        files.push({ relativePath, content });
      } finally {
        await handle.close();
      }
    }
  }
  await visit("");
  if (signature !== (await packageFileSignature(directory)))
    throw new PackageInventoryError("Package changed during inspection");
  return { files, directories, signature, digest: packageContentDigest(files) };
}
