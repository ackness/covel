import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

interface PackageFile {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface CachedDigest {
  readonly signature: string;
  readonly digest: Promise<string>;
}

// One entry per root, including in-flight reads. Bound temporary installation
// and generation roots too; an evicted package is simply hashed on its next read.
const MAX_CACHED_PACKAGES = 256;
const packageDigests = new Map<string, CachedDigest>();
const compareNames = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Inventory the same regular files used by the content hash, without reading bytes. */
async function packageFiles(root: string): Promise<PackageFile[]> {
  const files: PackageFile[] = [];
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    entries.sort((a, b) => compareNames(a.name, b.name));
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === ".DS_Store" ||
        entry.name.startsWith(".covel-")
      )
        continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const filename = path.join(root, name);
      if (entry.isDirectory()) {
        if (!(await lstat(filename)).isDirectory())
          throw new Error("Package directory changed during digest");
        await visit(name);
      } else if (entry.isFile()) {
        const stat = await lstat(filename);
        if (!stat.isFile())
          throw new Error("Package file changed during digest");
        files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await visit("");
  return files;
}

async function hashPackageFiles(
  root: string,
  files: readonly PackageFile[],
): Promise<string> {
  const hash = createHash("sha256");
  // Preserve the existing sorted directory traversal order of the content hash.
  for (const { name } of files) {
    const file = await open(
      path.join(root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (!(await file.stat()).isFile())
        throw new Error("Package file changed during digest");
      const content = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false }))
        content.update(chunk);
      hash.update(JSON.stringify([name, content.digest("hex")]));
    } finally {
      await file.close();
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Fingerprint package paths and bytes, including lore, translations, data and
 * media. Host receipts, generation markers and repository/OS bookkeeping do
 * not describe the world. Never follow links or read special files.
 * Reuse the content hash while sorted file paths, sizes and mtimes are unchanged.
 */
export async function worldPackageDigest(
  root: string,
): Promise<string | undefined> {
  let cacheKey = path.resolve(root);
  let cached: CachedDigest | undefined;
  try {
    if (!(await lstat(root)).isDirectory()) {
      packageDigests.delete(cacheKey);
      return undefined;
    }
    cacheKey = await realpath(root);
    const files = await packageFiles(cacheKey);
    const signature = JSON.stringify(
      [...files]
        .sort((a, b) => compareNames(a.name, b.name))
        .map(({ name, size, mtimeMs }) => [name, size, mtimeMs]),
    );
    cached = packageDigests.get(cacheKey);
    if (cached?.signature !== signature) {
      cached = { signature, digest: hashPackageFiles(cacheKey, files) };
    }
    // Refresh recency; replacing a signature never retains the old file list.
    packageDigests.delete(cacheKey);
    packageDigests.set(cacheKey, cached);
    if (packageDigests.size > MAX_CACHED_PACKAGES) {
      const oldest = packageDigests.keys().next().value;
      if (oldest !== undefined) packageDigests.delete(oldest);
    }
    return await cached.digest;
  } catch (error) {
    if (!cached || packageDigests.get(cacheKey) === cached)
      packageDigests.delete(cacheKey);
    // Missing or temporarily unreadable packages must not hide playable records.
    console.warn(`[world-package] Cannot fingerprint ${root}:`, error);
    return undefined;
  }
}
