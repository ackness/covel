/**
 * Electron-free ZIP reader used by the desktop asset importer.
 *
 * Split out of `import-assets.ts` so the security-critical parser has no
 * Electron coupling and can be unit-tested standalone (see
 * `zip-extract.selfcheck.ts`). Reads the central directory then inflates each
 * entry with `node:zlib`.
 *
 * Guards (defence against zip-slip / symlink / zip-bomb):
 *   - Absolute paths, `..` traversal, drive letters, NUL bytes, symlinks are rejected.
 *   - Entry count, total + per-entry uncompressed bytes, and expansion ratio are
 *     capped via `LIMITS` (mirrors the server install limits — see below).
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const inflateRawAsync = promisify(zlib.inflateRaw);

// Mirror of the server-side install limits — single source of truth lives in
// `apps/server/src/routes/api/install/shared.ts` (`LIMITS`). Desktop can't
// import from `@covel/server` (not a dependency, separate esbuild bundle), so
// the constants are duplicated verbatim; keep them in sync.
export const LIMITS = {
  maxEntries: 2000,
  maxUncompressedBytes: 200 * 1024 * 1024, // 200 MB
  // Uncompressed/compressed ratio ceiling — catches zip-bombs that stay small
  // on disk but explode on extract.
  maxExpansionRatio: 100,
} as const;

/** Sanitize an entry name inside an archive — reject anything that escapes root. */
export function safeEntryPath(rawName: string): string | null {
  if (!rawName) return null;
  // Disallow absolute paths and Windows drive letters
  if (rawName.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawName)) return null;
  // Normalize and ensure we stay inside the target root
  const normalized = path.posix.normalize(rawName.replace(/\\/g, "/"));
  if (normalized.startsWith("..") || normalized.includes("/../")) return null;
  // Reject names with NUL bytes
  if (normalized.includes("\0")) return null;
  return normalized;
}

/** Lightweight ZIP reader (central directory only, uses native zlib for inflate). */
export async function extractZipSafely(
  zipPath: string,
  targetDir: string,
): Promise<{ entries: number; rootPrefix: string | null }> {
  // Bound the compressed read. Local imports may be larger than an HTTP upload,
  // so we gate on the uncompressed ceiling rather than the server's 20 MB
  // upload cap — this only stops us slurping a multi-GB file into memory.
  const fileSize = fs.statSync(zipPath).size;
  if (fileSize > LIMITS.maxUncompressedBytes) {
    throw new Error(
      `Zip file exceeds ${LIMITS.maxUncompressedBytes} bytes (${fileSize})`,
    );
  }

  const buf = fs.readFileSync(zipPath);
  // Find end-of-central-directory record
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Invalid zip: EOCD not found");

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  if (totalEntries > LIMITS.maxEntries) {
    throw new Error(
      `Zip contains too many entries (${totalEntries} > ${LIMITS.maxEntries})`,
    );
  }
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset + cdSize > buf.length)
    throw new Error("Invalid zip: CD out of range");

  const CD_SIG = 0x02014b50;
  const LFH_SIG = 0x04034b50;

  let cursor = cdOffset;
  let extracted = 0;
  let totalUncompressed = 0;
  const rootPrefixes = new Set<string>();

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > buf.length)
      throw new Error("Invalid zip: CD header truncated");
    if (buf.readUInt32LE(cursor) !== CD_SIG)
      throw new Error("Invalid zip: bad CD signature");

    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const externalAttr = buf.readUInt32LE(cursor + 38);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const rawName = buf
      .slice(cursor + 46, cursor + 46 + nameLen)
      .toString("utf-8");

    cursor += 46 + nameLen + extraLen + commentLen;

    // Reject symlinks — the high 4 bits of externalAttr encode the Unix
    // file type. 0xA000 = S_IFLNK.
    if (((externalAttr >>> 16) & 0xf000) === 0xa000) {
      throw new Error(`Zip entry refuses symlink: ${rawName}`);
    }

    const safe = safeEntryPath(rawName);
    if (safe === null) {
      throw new Error(`Zip entry refuses unsafe path: ${rawName}`);
    }

    // Cheap early guard on the declared size before we allocate anything.
    if (uncompressedSize > LIMITS.maxUncompressedBytes) {
      throw new Error(
        `Zip entry exceeds ${LIMITS.maxUncompressedBytes} bytes: ${safe}`,
      );
    }

    // Track root-level prefix (first path segment) to detect "single top-level dir" archives
    const firstSeg = safe.split("/")[0];
    if (firstSeg) rootPrefixes.add(firstSeg);

    const isDir =
      safe.endsWith("/") ||
      (uncompressedSize === 0 && compressedSize === 0 && safe.endsWith("/"));
    const outPath = path.join(targetDir, safe);
    // Defence in depth: ensure resolved path is still inside targetDir
    const rel = path.relative(targetDir, outPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Zip entry escapes target dir: ${rawName}`);
    }

    if (isDir) {
      fs.mkdirSync(outPath, { recursive: true });
      continue;
    }

    // Read local file header to locate the data
    if (localOffset + 30 > buf.length)
      throw new Error("Invalid zip: LFH truncated");
    if (buf.readUInt32LE(localOffset) !== LFH_SIG)
      throw new Error("Invalid zip: bad LFH signature");
    const lfhNameLen = buf.readUInt16LE(localOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) throw new Error("Invalid zip: data out of range");

    const compressed = buf.slice(dataStart, dataEnd);
    let output: Buffer;
    if (method === 0) {
      output = compressed;
    } else if (method === 8) {
      // `maxOutputLength` bounds a single inflate so a lying header can't
      // balloon memory; exceeding it rejects with ERR_BUFFER_TOO_LARGE.
      output = (await inflateRawAsync(compressed, {
        maxOutputLength: LIMITS.maxUncompressedBytes,
      })) as Buffer;
    } else {
      throw new Error(`Unsupported zip compression method: ${method}`);
    }

    // Count real inflated bytes (authoritative, not the header claim).
    totalUncompressed += output.length;
    if (totalUncompressed > LIMITS.maxUncompressedBytes) {
      throw new Error(
        `Zip uncompressed size exceeds ${LIMITS.maxUncompressedBytes} bytes`,
      );
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output);
    extracted += 1;
  }

  // Expansion-ratio guard — total inflated bytes vs. the compressed file.
  const ratio = buf.length > 0 ? totalUncompressed / buf.length : 0;
  if (ratio > LIMITS.maxExpansionRatio) {
    throw new Error(
      `Zip expansion ratio ${ratio.toFixed(1)}x exceeds limit ${LIMITS.maxExpansionRatio}x`,
    );
  }

  // If all entries share a single top-level dir we consider that the "package root"
  const rootPrefix =
    rootPrefixes.size === 1 ? Array.from(rootPrefixes.values())[0] : null;

  return { entries: extracted, rootPrefix };
}
