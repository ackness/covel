/**
 * Shared install helpers — zip extraction, path safety, atomic materialisation,
 * and error mapping used by both plugin and world install routes.
 *
 * Security:
 *   - Zip-slip protection: entries whose resolved path escapes the target are rejected.
 *   - Absolute paths, path traversal (..), symlinks, and entries with control chars
 *     are rejected.
 *   - Size + entry-count caps (see `LIMITS`) guard against zip bombs.
 *   - Target directory must not already exist (409) — upgrades require manual removal.
 */

import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import path from "node:path";
import yauzl, { type Entry, type ZipFile } from "yauzl";

// ── Limits (defensive against zip bombs) ────────────────────────

export const LIMITS = {
  maxUploadBytes: 20 * 1024 * 1024, // 20 MB
  maxEntries: 2000,
  maxUncompressedBytes: 200 * 1024 * 1024, // 200 MB
  maxFileNameLength: 512,
  // Uncompressed/compressed ratio ceiling — catches zip-bombs that stay under
  // `maxUploadBytes` but would explode on extract.
  maxExpansionRatio: 100,
} as const;

// ── Error helpers ───────────────────────────────────────────────

export type HttpError = Error & { httpStatus: number };

export function httpError(status: number, message: string): HttpError {
  const e = new Error(message) as HttpError;
  e.httpStatus = status;
  return e;
}

function isFsErrorCode(err: unknown, ...codes: string[]): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    codes.includes((err as { code: string }).code)
  );
}

export function errorResponse(err: unknown): {
  status: number;
  body: { error: string; details?: unknown };
} {
  if (err instanceof Error) {
    const httpStatus = (err as Error & { httpStatus?: number }).httpStatus;
    return { status: httpStatus ?? 400, body: { error: err.message } };
  }
  return { status: 500, body: { error: "unknown error" } };
}

// ── Helpers ─────────────────────────────────────────────────────

export interface ExtractedEntry {
  readonly relativePath: string;
  readonly content: Buffer;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect the Unix file mode encoded in a zip entry's external attributes.
 * Returns `null` when the entry was produced by a non-Unix tool (mode=0).
 *
 * Layout: upper 16 bits of `externalFileAttributes` carry st_mode when
 * `versionMadeBy >> 8 === 3` (Unix).
 */
function zipEntryUnixMode(entry: Entry): number | null {
  const unixSource = entry.versionMadeBy >>> 8 === 3;
  if (!unixSource) return null;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return mode === 0 ? null : mode;
}

function sanitizeRelativePath(raw: string, targetRoot: string): string | null {
  if (raw.length === 0 || raw.length > LIMITS.maxFileNameLength) return null;
  // Strip Windows-style separators, reject control chars.
  const normalized = raw.replace(/\\/g, "/");
  if (/[\x00-\x1f]/.test(normalized)) return null;
  if (normalized.startsWith("/")) return null;
  // Reject absolute paths & drive letters.
  if (path.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return null;

  const resolved = path.resolve(targetRoot, normalized);
  const rel = path.relative(targetRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;

  return normalized;
}

export async function readAllEntries(
  buffer: Buffer,
  sentinelRoot: string,
): Promise<ExtractedEntry[]> {
  return new Promise((resolveFn, rejectFn) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        rejectFn(err ?? httpError(400, "failed to open zip"));
        return;
      }

      const zf = zipfile as ZipFile;
      const entries: ExtractedEntry[] = [];
      let entryCount = 0;
      let totalUncompressed = 0;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const fail = (status: number, message: string) =>
        finish(() => {
          zf.close();
          rejectFn(httpError(status, message));
        });

      zf.on("error", (e) => finish(() => rejectFn(e)));
      zf.on("end", () =>
        finish(() => {
          const ratio =
            buffer.length > 0 ? totalUncompressed / buffer.length : 0;
          if (ratio > LIMITS.maxExpansionRatio) {
            rejectFn(
              httpError(
                400,
                `zip expansion ratio ${ratio.toFixed(1)}x exceeds limit ${LIMITS.maxExpansionRatio}x`,
              ),
            );
            return;
          }
          resolveFn(entries);
        }),
      );

      zf.on("entry", (entry: Entry) => {
        if (settled) return;
        entryCount += 1;
        if (entryCount > LIMITS.maxEntries) {
          fail(400, `zip contains too many entries (> ${LIMITS.maxEntries})`);
          return;
        }

        // Skip directory entries.
        if (entry.fileName.endsWith("/")) {
          zf.readEntry();
          return;
        }

        const unixMode = zipEntryUnixMode(entry);
        if (unixMode !== null && (unixMode & 0o170000) !== 0o100000) {
          // Non-regular Unix file: symlink (0o120000), device, fifo, etc.
          fail(400, `unsupported entry type in ${entry.fileName}`);
          return;
        }

        const safeRel = sanitizeRelativePath(entry.fileName, sentinelRoot);
        if (!safeRel) {
          fail(400, `unsafe entry path: ${entry.fileName}`);
          return;
        }

        const uncompressed = Number(entry.uncompressedSize ?? 0);
        if (!Number.isFinite(uncompressed) || uncompressed < 0) {
          fail(400, `invalid uncompressed size for ${safeRel}`);
          return;
        }
        totalUncompressed += uncompressed;
        if (totalUncompressed > LIMITS.maxUncompressedBytes) {
          fail(
            400,
            `zip uncompressed size exceeds ${LIMITS.maxUncompressedBytes} bytes`,
          );
          return;
        }

        zf.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            fail(
              500,
              `failed to read entry ${safeRel}: ${streamErr?.message ?? "unknown"}`,
            );
            return;
          }
          const chunks: Buffer[] = [];
          let seen = 0;
          readStream.on("data", (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > LIMITS.maxUncompressedBytes) {
              readStream.destroy();
              fail(400, "entry exceeds size budget mid-stream");
              return;
            }
            chunks.push(chunk);
          });
          readStream.on("end", () => {
            if (settled) return;
            entries.push({
              relativePath: safeRel,
              content: Buffer.concat(chunks),
            });
            zf.readEntry();
          });
          readStream.on("error", (streamError) => {
            fail(
              500,
              `read stream error on ${safeRel}: ${streamError.message}`,
            );
          });
        });
      });

      zf.readEntry();
    });
  });
}

interface BlobLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function isBlobLike(value: unknown): value is BlobLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    typeof (value as { arrayBuffer: unknown }).arrayBuffer === "function"
  );
}

export async function collectUpload(file: BlobLike): Promise<Buffer> {
  const ab = await file.arrayBuffer();
  if (ab.byteLength > LIMITS.maxUploadBytes) {
    throw httpError(413, `upload exceeds ${LIMITS.maxUploadBytes} bytes`);
  }
  return Buffer.from(ab);
}

/**
 * Early Content-Length gate. Saves us from reading a gigabyte into memory
 * when the client is honest about the size. A malicious client can still
 * lie about the header — the post-read check in `collectUpload` catches that.
 */
export function rejectByContentLength(
  header: string | undefined,
): HttpError | null {
  if (!header) return null;
  const n = Number(header);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > LIMITS.maxUploadBytes) {
    return httpError(413, `upload exceeds ${LIMITS.maxUploadBytes} bytes`);
  }
  return null;
}

async function writeEntriesToDir(
  targetDir: string,
  entries: readonly ExtractedEntry[],
): Promise<void> {
  for (const entry of entries) {
    const abs = path.join(targetDir, entry.relativePath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, entry.content);
  }
}

export async function materializeAtomically(
  finalDir: string,
  writer: (stagingDir: string) => Promise<void>,
): Promise<void> {
  const parent = path.dirname(finalDir);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, ".covel-install-"));
  try {
    await writer(staging);
    // `rename` onto an existing non-empty dir fails with ENOTEMPTY on POSIX and
    // EEXIST on some kernels; onto an existing file it's ENOTDIR. We rely on the
    // kernel as the single arbiter — no TOCTOU gap between a prior `exists` check
    // and the rename.
    try {
      await rename(staging, finalDir);
    } catch (err) {
      if (isFsErrorCode(err, "EEXIST", "ENOTEMPTY", "EISDIR", "ENOTDIR")) {
        throw httpError(
          409,
          `target already exists: ${path.basename(finalDir)}`,
        );
      }
      throw err;
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/** Write all extracted entries under `finalDir` atomically (staging + rename). */
export async function materializeEntries(
  finalDir: string,
  entries: readonly ExtractedEntry[],
): Promise<void> {
  await materializeAtomically(finalDir, async (staging) => {
    await writeEntriesToDir(staging, entries);
  });
}
