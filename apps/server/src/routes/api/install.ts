/**
 * API Install routes — drag-and-drop import of plugin + world packages.
 *
 * POST /api/install/plugin — multipart (field `file`), accepts a .zip containing
 *   either a root-level PLUGIN.md + package.json, or runtimes/<sub>/PLUGIN.md
 *   entries (multi-runtime layout). Extracts to the user plugins dir and
 *   returns `{ ok, id, path, restartRequired: true }`.
 *
 * POST /api/install/world — multipart (field `file`), accepts a .zip containing
 *   world.yaml + WORLD.md at the root. Extracts to the user worlds dir and
 *   returns `{ ok, id, path, restartRequired: false }` (worlds reload on demand).
 *
 * Security:
 *   - Zip-slip protection: entries whose resolved path escapes the target are rejected.
 *   - Absolute paths, path traversal (..), symlinks, and entries with control chars
 *     are rejected.
 *   - Size + entry-count caps (see `LIMITS`) guard against zip bombs.
 *   - Manifest must validate via the shared Zod schemas before any files are written.
 *   - Target directory must not already exist (409) — upgrades require manual removal.
 */

import { mkdir, mkdtemp, rename, rm, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';
import {
  readRuntimeEnv,
  validatePluginManifest,
  validateWorldManifest,
  formatValidationErrors,
} from '@covel/shared';
import { BUILTIN_PLUGIN_IDS } from '@covel/plugin-loader';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

export const installRoutes = new Hono();

// ── Limits (defensive against zip bombs) ────────────────────────

const LIMITS = {
  maxUploadBytes: 20 * 1024 * 1024, // 20 MB
  maxEntries: 2000,
  maxUncompressedBytes: 200 * 1024 * 1024, // 200 MB
  maxFileNameLength: 512,
  // Uncompressed/compressed ratio ceiling — catches zip-bombs that stay under
  // `maxUploadBytes` but would explode on extract.
  maxExpansionRatio: 100,
} as const;

// ── Error helpers ───────────────────────────────────────────────

type HttpError = Error & { httpStatus: number };

function httpError(status: number, message: string): HttpError {
  const e = new Error(message) as HttpError;
  e.httpStatus = status;
  return e;
}

function isFsErrorCode(err: unknown, ...codes: string[]): boolean {
  return typeof err === 'object'
    && err !== null
    && 'code' in err
    && typeof (err as { code: unknown }).code === 'string'
    && codes.includes((err as { code: string }).code);
}

// ── Helpers ─────────────────────────────────────────────────────

interface ExtractedEntry {
  readonly relativePath: string;
  readonly content: Buffer;
}

async function pathExists(p: string): Promise<boolean> {
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
  const unixSource = (entry.versionMadeBy >>> 8) === 3;
  if (!unixSource) return null;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return mode === 0 ? null : mode;
}

function sanitizeRelativePath(raw: string, targetRoot: string): string | null {
  if (raw.length === 0 || raw.length > LIMITS.maxFileNameLength) return null;
  // Strip Windows-style separators, reject control chars.
  const normalized = raw.replace(/\\/g, '/');
  if (/[\x00-\x1f]/.test(normalized)) return null;
  if (normalized.startsWith('/')) return null;
  // Reject absolute paths & drive letters.
  if (path.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return null;

  const resolved = path.resolve(targetRoot, normalized);
  const rel = path.relative(targetRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  return normalized;
}

async function readAllEntries(
  buffer: Buffer,
  sentinelRoot: string,
): Promise<ExtractedEntry[]> {
  return new Promise((resolveFn, rejectFn) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        rejectFn(err ?? httpError(400, 'failed to open zip'));
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

      zf.on('error', (e) => finish(() => rejectFn(e)));
      zf.on('end', () => finish(() => {
        const ratio = buffer.length > 0 ? totalUncompressed / buffer.length : 0;
        if (ratio > LIMITS.maxExpansionRatio) {
          rejectFn(httpError(
            400,
            `zip expansion ratio ${ratio.toFixed(1)}x exceeds limit ${LIMITS.maxExpansionRatio}x`,
          ));
          return;
        }
        resolveFn(entries);
      }));

      zf.on('entry', (entry: Entry) => {
        if (settled) return;
        entryCount += 1;
        if (entryCount > LIMITS.maxEntries) {
          fail(400, `zip contains too many entries (> ${LIMITS.maxEntries})`);
          return;
        }

        // Skip directory entries.
        if (/\/$/.test(entry.fileName)) {
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
          fail(400, `zip uncompressed size exceeds ${LIMITS.maxUncompressedBytes} bytes`);
          return;
        }

        zf.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            fail(500, `failed to read entry ${safeRel}: ${streamErr?.message ?? 'unknown'}`);
            return;
          }
          const chunks: Buffer[] = [];
          let seen = 0;
          readStream.on('data', (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > LIMITS.maxUncompressedBytes) {
              readStream.destroy();
              fail(400, 'entry exceeds size budget mid-stream');
              return;
            }
            chunks.push(chunk);
          });
          readStream.on('end', () => {
            if (settled) return;
            entries.push({ relativePath: safeRel, content: Buffer.concat(chunks) });
            zf.readEntry();
          });
          readStream.on('error', (streamError) => {
            fail(500, `read stream error on ${safeRel}: ${streamError.message}`);
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

function isBlobLike(value: unknown): value is BlobLike {
  return (
    typeof value === 'object'
    && value !== null
    && 'arrayBuffer' in value
    && typeof (value as { arrayBuffer: unknown }).arrayBuffer === 'function'
  );
}

async function collectUpload(file: BlobLike): Promise<Buffer> {
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
function rejectByContentLength(header: string | undefined): HttpError | null {
  if (!header) return null;
  const n = Number(header);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > LIMITS.maxUploadBytes) {
    return httpError(413, `upload exceeds ${LIMITS.maxUploadBytes} bytes`);
  }
  return null;
}

async function writeEntriesToDir(targetDir: string, entries: readonly ExtractedEntry[]): Promise<void> {
  for (const entry of entries) {
    const abs = path.join(targetDir, entry.relativePath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, entry.content);
  }
}

async function materializeAtomically(
  finalDir: string,
  writer: (stagingDir: string) => Promise<void>,
): Promise<void> {
  const parent = path.dirname(finalDir);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, '.covel-install-'));
  try {
    await writer(staging);
    // `rename` onto an existing non-empty dir fails with ENOTEMPTY on POSIX and
    // EEXIST on some kernels; onto an existing file it's ENOTDIR. We rely on the
    // kernel as the single arbiter — no TOCTOU gap between a prior `exists` check
    // and the rename.
    try {
      await rename(staging, finalDir);
    } catch (err) {
      if (isFsErrorCode(err, 'EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR')) {
        throw httpError(409, `target already exists: ${path.basename(finalDir)}`);
      }
      throw err;
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

function errorResponse(err: unknown): { status: number; body: { error: string; details?: unknown } } {
  if (err instanceof Error) {
    const httpStatus = (err as Error & { httpStatus?: number }).httpStatus;
    return { status: httpStatus ?? 400, body: { error: err.message } };
  }
  return { status: 500, body: { error: 'unknown error' } };
}

// ── Plugin install ──────────────────────────────────────────────

interface PluginManifestSummary {
  readonly pluginId: string;
}

function findPluginManifestEntry(entries: readonly ExtractedEntry[]): ExtractedEntry | null {
  // Root-level PLUGIN.md (single-runtime layout).
  const root = entries.find((e) => e.relativePath === 'PLUGIN.md');
  if (root) return root;
  // Multi-runtime layout: at least one runtimes/<sub>/PLUGIN.md must exist.
  const runtimeManifest = entries.find((e) => /^runtimes\/[^/]+\/PLUGIN\.md$/.test(e.relativePath));
  return runtimeManifest ?? null;
}

function readPackageId(entries: readonly ExtractedEntry[]): string | null {
  const pkg = entries.find((e) => e.relativePath === 'package.json');
  if (!pkg) return null;
  try {
    const json = JSON.parse(pkg.content.toString('utf-8')) as { name?: unknown };
    if (typeof json.name !== 'string' || !json.name.trim()) return null;
    // `@covel/plugin-foo` → `plugin-foo`; `narrator` stays.
    const name = json.name.trim();
    const after = name.includes('/') ? name.split('/').slice(-1)[0] : name;
    return after;
  } catch {
    return null;
  }
}

/** Root segment of a plugin manifest `name` — handles `scope/sub` multi-runtime layouts. */
function manifestRootId(name: string): string {
  const trimmed = name.trim();
  return trimmed.includes('/') ? (trimmed.split('/')[0] ?? trimmed) : trimmed;
}

/**
 * Accept either exact equality or the Covel convention where `package.json`
 * uses `@covel/plugin-<id>` (basename: `plugin-<id>`) and `PLUGIN.md` declares
 * `name: <id>`. Both should map to the same logical plugin identity.
 */
function pluginIdsConsistent(pkgId: string, manifestRoot: string): boolean {
  if (pkgId === manifestRoot) return true;
  if (pkgId === `plugin-${manifestRoot}`) return true;
  return false;
}

function validatePluginBundle(entries: readonly ExtractedEntry[]): PluginManifestSummary {
  const pkgId = readPackageId(entries);
  if (!pkgId) {
    throw httpError(400, 'package.json missing or has no valid "name" field');
  }
  if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(pkgId)) {
    throw httpError(400, `invalid plugin id derived from package.json: ${pkgId}`);
  }
  // Reserve builtin plugin IDs — third-party installs cannot shadow a shipped
  // plugin's `plugin_data` namespace by claiming the same name. The list lives
  // in `@covel/plugin-loader` (BUILTIN_PLUGIN_IDS) so it stays in sync with
  // the directory contents under `plugins/`.
  const pkgRoot = manifestRootId(pkgId);
  if (BUILTIN_PLUGIN_IDS.has(pkgRoot)) {
    throw httpError(409, `plugin id "${pkgRoot}" is reserved for a builtin plugin`);
  }

  const manifestEntry = findPluginManifestEntry(entries);
  if (!manifestEntry) {
    throw httpError(400, 'no PLUGIN.md found (expected root PLUGIN.md or runtimes/<sub>/PLUGIN.md)');
  }

  // Validate every PLUGIN.md we find — multi-runtime layouts must all be valid —
  // AND enforce that each manifest's root `name` is consistent with the package.json id.
  // Without this check a bundle could install into dir `plugin-innocent` while
  // declaring `name: narrator`, which the loader would then treat as the
  // real narrator and collide with its plugin-data namespace.
  const manifests = entries.filter(
    (e) => e.relativePath === 'PLUGIN.md' || /^runtimes\/[^/]+\/PLUGIN\.md$/.test(e.relativePath),
  );
  for (const m of manifests) {
    const parsed = matter(m.content.toString('utf-8'));
    const result = validatePluginManifest(parsed.data);
    if (!result.valid) {
      throw httpError(
        400,
        `invalid frontmatter in ${m.relativePath}:\n${formatValidationErrors(result.errors ?? [])}`,
      );
    }
    const declared = (result.data as { name?: unknown }).name;
    if (typeof declared !== 'string' || declared.trim() === '') {
      throw httpError(400, `PLUGIN.md frontmatter in ${m.relativePath} missing "name"`);
    }
    const declaredRoot = manifestRootId(declared);
    if (!pluginIdsConsistent(pkgId, declaredRoot)) {
      throw httpError(
        400,
        `plugin id mismatch: package.json name resolves to "${pkgId}" but ${m.relativePath} declares "${declaredRoot}"`,
      );
    }
  }

  return { pluginId: pkgId };
}

installRoutes.post('/plugin', async (c) => {
  try {
    const tooLarge = rejectByContentLength(c.req.header('content-length'));
    if (tooLarge) throw tooLarge;

    const form = await c.req.formData();
    const file = form.get('file');
    if (!isBlobLike(file)) {
      return c.json({ error: 'multipart field "file" is required' }, 400);
    }

    const buffer = await collectUpload(file);
    // First extract + validate against a throwaway sentinel root (path-traversal check
    // uses a fixed root string — entries get re-resolved under the final dir later).
    const entries = await readAllEntries(buffer, '/covel-plugin-install-sentinel');
    const summary = validatePluginBundle(entries);

    const env = readRuntimeEnv();
    const root = env.userPluginsDir
      ?? (env.covelHome ? path.join(env.covelHome, 'plugins') : path.join(homedir(), '.covel', 'plugins'));

    const finalDir = path.join(root, summary.pluginId);
    await materializeAtomically(finalDir, async (staging) => {
      await writeEntriesToDir(staging, entries);
    });

    return c.json({
      ok: true,
      kind: 'plugin',
      id: summary.pluginId,
      restartRequired: true,
    });
  } catch (err) {
    const { status, body } = errorResponse(err);
    return c.json(body, status as 400 | 409 | 413 | 500);
  }
});

// ── World install ───────────────────────────────────────────────

interface WorldManifestSummary {
  readonly worldId: string;
}

function findWorldYaml(entries: readonly ExtractedEntry[]): ExtractedEntry | null {
  return entries.find((e) => e.relativePath === 'world.yaml') ?? null;
}

function validateWorldBundle(entries: readonly ExtractedEntry[]): WorldManifestSummary {
  const yamlEntry = findWorldYaml(entries);
  if (!yamlEntry) {
    throw httpError(400, 'world.yaml not found at zip root');
  }

  let raw: unknown;
  try {
    raw = parseYaml(yamlEntry.content.toString('utf-8'));
  } catch (parseErr) {
    throw httpError(400, `world.yaml parse error: ${(parseErr as Error).message}`);
  }

  const result = validateWorldManifest(raw);
  if (!result.valid) {
    throw httpError(400, `invalid world.yaml:\n${formatValidationErrors(result.errors ?? [])}`);
  }

  const manifest = result.data as { id?: unknown };
  if (typeof manifest.id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(manifest.id)) {
    throw httpError(400, 'world.yaml `id` must match /^[a-z0-9_-]{1,64}$/i');
  }

  return { worldId: manifest.id };
}

installRoutes.post('/world', async (c) => {
  try {
    const tooLarge = rejectByContentLength(c.req.header('content-length'));
    if (tooLarge) throw tooLarge;

    const form = await c.req.formData();
    const file = form.get('file');
    if (!isBlobLike(file)) {
      return c.json({ error: 'multipart field "file" is required' }, 400);
    }

    const buffer = await collectUpload(file);
    const entries = await readAllEntries(buffer, '/covel-world-install-sentinel');
    const summary = validateWorldBundle(entries);

    const env = readRuntimeEnv();
    const root = env.userWorldsDir
      ?? (env.covelHome ? path.join(env.covelHome, 'worlds') : path.join(homedir(), '.covel', 'worlds'));

    const finalDir = path.join(root, summary.worldId);
    await materializeAtomically(finalDir, async (staging) => {
      await writeEntriesToDir(staging, entries);
    });

    return c.json({
      ok: true,
      kind: 'world',
      id: summary.worldId,
      restartRequired: false,
    });
  } catch (err) {
    const { status, body } = errorResponse(err);
    return c.json(body, status as 400 | 409 | 413 | 500);
  }
});

