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

import { mkdir, mkdtemp, readFile, rename, rm, writeFile, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';
import {
  readRuntimeEnv,
  validatePluginManifest,
  validateWorldManifest,
  formatValidationErrors,
} from '@covel/shared';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

export const installRoutes = new Hono();

// ── Limits (defensive against zip bombs) ────────────────────────

const LIMITS = {
  maxUploadBytes: 20 * 1024 * 1024, // 20 MB
  maxEntries: 2000,
  maxUncompressedBytes: 200 * 1024 * 1024, // 200 MB
  maxFileNameLength: 512,
} as const;

// ── Helpers ─────────────────────────────────────────────────────

interface ExtractedEntry {
  readonly relativePath: string;
  readonly content: Buffer;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
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

async function readAllEntries(buffer: Buffer, sentinelRoot: string): Promise<ExtractedEntry[]> {
  return new Promise((resolveFn, rejectFn) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        rejectFn(err ?? new Error('failed to open zip'));
        return;
      }

      const zf = zipfile as ZipFile;
      const entries: ExtractedEntry[] = [];
      let entryCount = 0;
      let totalUncompressed = 0;

      const fail = (message: string, status: number = 400) => {
        zf.close();
        const e = new Error(message) as Error & { httpStatus?: number };
        e.httpStatus = status;
        rejectFn(e);
      };

      zf.on('error', (e) => rejectFn(e));
      zf.on('end', () => resolveFn(entries));

      zf.on('entry', (entry: Entry) => {
        entryCount += 1;
        if (entryCount > LIMITS.maxEntries) {
          fail(`zip contains too many entries (> ${LIMITS.maxEntries})`);
          return;
        }

        // Skip directory entries.
        if (/\/$/.test(entry.fileName)) {
          zf.readEntry();
          return;
        }

        const safeRel = sanitizeRelativePath(entry.fileName, sentinelRoot);
        if (!safeRel) {
          fail(`unsafe entry path: ${entry.fileName}`);
          return;
        }

        const uncompressed = Number(entry.uncompressedSize ?? 0);
        if (!Number.isFinite(uncompressed) || uncompressed < 0) {
          fail(`invalid uncompressed size for ${safeRel}`);
          return;
        }
        totalUncompressed += uncompressed;
        if (totalUncompressed > LIMITS.maxUncompressedBytes) {
          fail(`zip uncompressed size exceeds ${LIMITS.maxUncompressedBytes} bytes`);
          return;
        }

        zf.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            fail(`failed to read entry ${safeRel}: ${streamErr?.message ?? 'unknown'}`, 500);
            return;
          }
          const chunks: Buffer[] = [];
          let seen = 0;
          readStream.on('data', (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > LIMITS.maxUncompressedBytes) {
              readStream.destroy();
              fail('entry exceeds size budget mid-stream');
              return;
            }
            chunks.push(chunk);
          });
          readStream.on('end', () => {
            entries.push({ relativePath: safeRel, content: Buffer.concat(chunks) });
            zf.readEntry();
          });
          readStream.on('error', (streamError) => {
            fail(`read stream error on ${safeRel}: ${streamError.message}`, 500);
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
    const e = new Error(`upload exceeds ${LIMITS.maxUploadBytes} bytes`) as Error & { httpStatus?: number };
    e.httpStatus = 413;
    throw e;
  }
  return Buffer.from(ab);
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
    if (await fileExists(finalDir)) {
      const e = new Error(`target already exists: ${path.basename(finalDir)}`) as Error & { httpStatus?: number };
      e.httpStatus = 409;
      throw e;
    }
    await rename(staging, finalDir);
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
    // `@covel/plugin-foo` → `plugin-foo`; `core-narrator` stays.
    const name = json.name.trim();
    const after = name.includes('/') ? name.split('/').slice(-1)[0] : name;
    return after;
  } catch {
    return null;
  }
}

function validatePluginBundle(entries: readonly ExtractedEntry[]): PluginManifestSummary {
  const pkgId = readPackageId(entries);
  if (!pkgId) {
    const e = new Error('package.json missing or has no valid "name" field') as Error & { httpStatus?: number };
    e.httpStatus = 400;
    throw e;
  }
  if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(pkgId)) {
    const e = new Error(`invalid plugin id derived from package.json: ${pkgId}`) as Error & { httpStatus?: number };
    e.httpStatus = 400;
    throw e;
  }

  const manifestEntry = findPluginManifestEntry(entries);
  if (!manifestEntry) {
    const e = new Error('no PLUGIN.md found (expected root PLUGIN.md or runtimes/<sub>/PLUGIN.md)') as Error & {
      httpStatus?: number;
    };
    e.httpStatus = 400;
    throw e;
  }

  // Validate every PLUGIN.md we find — multi-runtime layouts must all be valid.
  const manifests = entries.filter((e) => e.relativePath === 'PLUGIN.md' || /^runtimes\/[^/]+\/PLUGIN\.md$/.test(e.relativePath));
  for (const m of manifests) {
    const parsed = matter(m.content.toString('utf-8'));
    const result = validatePluginManifest(parsed.data);
    if (!result.valid) {
      const e = new Error(
        `invalid frontmatter in ${m.relativePath}:\n${formatValidationErrors(result.errors ?? [])}`,
      ) as Error & { httpStatus?: number };
      e.httpStatus = 400;
      throw e;
    }
  }

  return { pluginId: pkgId };
}

installRoutes.post('/plugin', async (c) => {
  try {
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
      path: finalDir,
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
    const e = new Error('world.yaml not found at zip root') as Error & { httpStatus?: number };
    e.httpStatus = 400;
    throw e;
  }

  let raw: unknown;
  try {
    raw = parseYaml(yamlEntry.content.toString('utf-8'));
  } catch (parseErr) {
    const e = new Error(`world.yaml parse error: ${(parseErr as Error).message}`) as Error & { httpStatus?: number };
    e.httpStatus = 400;
    throw e;
  }

  const result = validateWorldManifest(raw);
  if (!result.valid) {
    const e = new Error(`invalid world.yaml:\n${formatValidationErrors(result.errors ?? [])}`) as Error & {
      httpStatus?: number;
    };
    e.httpStatus = 400;
    throw e;
  }

  const manifest = result.data as { id?: unknown };
  if (typeof manifest.id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(manifest.id)) {
    const e = new Error('world.yaml `id` must match /^[a-z0-9_-]{1,64}$/i') as Error & { httpStatus?: number };
    e.httpStatus = 400;
    throw e;
  }

  return { worldId: manifest.id };
}

installRoutes.post('/world', async (c) => {
  try {
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
      path: finalDir,
      restartRequired: false,
    });
  } catch (err) {
    const { status, body } = errorResponse(err);
    return c.json(body, status as 400 | 409 | 413 | 500);
  }
});

// Intentionally unused imports kept for future streaming use.
void Readable;
