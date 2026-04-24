/**
 * Install route tests — drag-and-drop plugin + world package import.
 *
 * Covers:
 *   - happy path (plugin + world)
 *   - zip-slip rejection (entry path escapes target)
 *   - invalid manifest rejection
 *   - overwrite rejection (409 when target exists)
 *   - missing multipart field (400)
 *   - multi-runtime plugin layout (runtimes/<sub>/PLUGIN.md)
 */

import { mkdtemp, mkdir, access, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { installRoutes } from '../../src/routes/api/install.js';

// ── Env override helpers ────────────────────────────────────────

function createTestApp(): Hono {
  const app = new Hono();
  app.route('/api/install', installRoutes);
  return app;
}

function zipToBuffer(zip: yazl.ZipFile): Promise<Buffer> {
  return new Promise((resolveFn, rejectFn) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolveFn(Buffer.concat(chunks)));
    zip.outputStream.on('error', rejectFn);
    zip.end();
  });
}

function buildZip(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) {
    zip.addBuffer(Buffer.from(content, 'utf-8'), name);
  }
  return zipToBuffer(zip);
}

function isYazlSafe(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith('/')) return false;
  if (name.includes('..')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00]/.test(name)) return false;
  return true;
}

/**
 * Build a zip where some entries may have paths yazl normally refuses
 * (absolute, parent traversal). Strategy: write unsafe entries under a
 * length-matched placeholder name, then substitute bytes back into the
 * emitted zip.
 */
async function buildZipWithRawEntries(entries: Array<{ name: string; content: string }>): Promise<Buffer> {
  const substitutions: Array<{ placeholder: string; target: string }> = [];
  const zip = new yazl.ZipFile();
  entries.forEach((entry, i) => {
    if (isYazlSafe(entry.name)) {
      zip.addBuffer(Buffer.from(entry.content, 'utf-8'), entry.name);
      return;
    }
    const seed = `UT${i}_`;
    const targetLen = Buffer.byteLength(entry.name, 'utf-8');
    if (targetLen < seed.length) {
      throw new Error(`malicious name too short: ${entry.name}`);
    }
    const placeholder = seed + 'X'.repeat(targetLen - seed.length);
    substitutions.push({ placeholder, target: entry.name });
    zip.addBuffer(Buffer.from(entry.content, 'utf-8'), placeholder);
  });

  const buf = await zipToBuffer(zip);
  for (const { placeholder, target } of substitutions) {
    const ph = Buffer.from(placeholder, 'utf-8');
    const tg = Buffer.from(target, 'utf-8');
    let idx = 0;
    while ((idx = buf.indexOf(ph, idx)) !== -1) {
      tg.copy(buf, idx);
      idx += tg.length;
    }
  }
  return buf;
}

async function postZip(app: Hono, url: string, zipBuffer: Buffer): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([zipBuffer], { type: 'application/zip' }), 'upload.zip');
  return app.request(url, { method: 'POST', body: form });
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ── Fixtures ────────────────────────────────────────────────────

const VALID_PLUGIN_MD = `---
name: test-plugin
pluginType: plugin
priority: 500
description: A test plugin
trigger:
  type: manual
---

# Test Plugin

Test plugin body.
`;

const VALID_PACKAGE_JSON = JSON.stringify({
  name: '@covel/plugin-test-plugin',
  version: '0.0.1',
  type: 'module',
}, null, 2);

const VALID_WORLD_YAML = `schemaVersion: "1.0"
id: test-world
name: Test World
version: "0.1.0"
summary: A synthetic world for install tests.
defaultLocale: en
supportedLocales:
  - en
tags:
  - test
`;

const VALID_WORLD_MD = '# Test World\n\nSynthetic lore.\n';

// ── Harness ─────────────────────────────────────────────────────

let tempRoot: string;
let pluginsDir: string;
let worldsDir: string;
let prevPluginsDir: string | undefined;
let prevWorldsDir: string | undefined;
let prevUserPluginsDir: string | undefined;
let prevUserWorldsDir: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'covel-install-'));
  pluginsDir = path.join(tempRoot, 'plugins');
  worldsDir = path.join(tempRoot, 'worlds');
  await mkdir(pluginsDir, { recursive: true });
  await mkdir(worldsDir, { recursive: true });

  prevPluginsDir = process.env.COVEL_PLUGINS_DIR;
  prevWorldsDir = process.env.COVEL_WORLDS_DIR;
  prevUserPluginsDir = process.env.COVEL_USER_PLUGINS_DIR;
  prevUserWorldsDir = process.env.COVEL_USER_WORLDS_DIR;

  // The install routes prefer userPluginsDir/userWorldsDir; force those via env.
  process.env.COVEL_USER_PLUGINS_DIR = pluginsDir;
  process.env.COVEL_USER_WORLDS_DIR = worldsDir;
  // Clear the non-user-scoped vars so the resolve order is unambiguous.
  delete process.env.COVEL_PLUGINS_DIR;
  delete process.env.COVEL_WORLDS_DIR;
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  if (prevPluginsDir === undefined) delete process.env.COVEL_PLUGINS_DIR;
  else process.env.COVEL_PLUGINS_DIR = prevPluginsDir;
  if (prevWorldsDir === undefined) delete process.env.COVEL_WORLDS_DIR;
  else process.env.COVEL_WORLDS_DIR = prevWorldsDir;
  if (prevUserPluginsDir === undefined) delete process.env.COVEL_USER_PLUGINS_DIR;
  else process.env.COVEL_USER_PLUGINS_DIR = prevUserPluginsDir;
  if (prevUserWorldsDir === undefined) delete process.env.COVEL_USER_WORLDS_DIR;
  else process.env.COVEL_USER_WORLDS_DIR = prevUserWorldsDir;
});

// ── Plugin install ──────────────────────────────────────────────

describe('POST /api/install/plugin', () => {
  it('accepts a valid single-runtime plugin package', async () => {
    const app = createTestApp();
    const zip = await buildZip({
      'PLUGIN.md': VALID_PLUGIN_MD,
      'package.json': VALID_PACKAGE_JSON,
    });
    const res = await postZip(app, '/api/install/plugin', zip);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      id: string;
      restartRequired: boolean;
      path?: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.id).toBe('plugin-test-plugin');
    expect(body.restartRequired).toBe(true);
    // Absolute filesystem path must not leak to the client.
    expect(body.path).toBeUndefined();

    const installedPlugin = path.join(pluginsDir, 'plugin-test-plugin', 'PLUGIN.md');
    await expect(readFile(installedPlugin, 'utf-8')).resolves.toContain('name: test-plugin');
  });

  it('accepts a multi-runtime layout (no root PLUGIN.md)', async () => {
    const app = createTestApp();
    const zip = await buildZip({
      'package.json': JSON.stringify({ name: 'multi-plugin' }),
      'runtimes/a/PLUGIN.md': VALID_PLUGIN_MD.replace('test-plugin', 'multi-plugin/a'),
      'runtimes/b/PLUGIN.md': VALID_PLUGIN_MD.replace('test-plugin', 'multi-plugin/b'),
    });
    const res = await postZip(app, '/api/install/plugin', zip);
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string };
    expect(body.id).toBe('multi-plugin');
    expect(await dirExists(path.join(pluginsDir, 'multi-plugin', 'runtimes', 'a'))).toBe(true);
  });

  it('rejects zip-slip entries', async () => {
    const app = createTestApp();
    const zip = await buildZipWithRawEntries([
      { name: 'package.json', content: VALID_PACKAGE_JSON },
      { name: 'PLUGIN.md', content: VALID_PLUGIN_MD },
      { name: '../escaped.txt', content: 'malicious' },
    ]);
    const res = await postZip(app, '/api/install/plugin', zip);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toMatch(/unsafe|invalid|traversal|relative/);
  });

  it('rejects missing package.json', async () => {
    const app = createTestApp();
    const zip = await buildZip({
      'PLUGIN.md': VALID_PLUGIN_MD,
    });
    const res = await postZip(app, '/api/install/plugin', zip);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/package\.json/);
  });

  it('rejects missing PLUGIN.md', async () => {
    const app = createTestApp();
    const zip = await buildZip({
      'package.json': VALID_PACKAGE_JSON,
      'README.md': 'hello',
    });
    const res = await postZip(app, '/api/install/plugin', zip);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/PLUGIN\.md/);
  });

  it('rejects invalid frontmatter', async () => {
    const app = createTestApp();
    const zip = await buildZip({
      'PLUGIN.md': '---\nname: bad\n---\nno pluginType no priority\n',
      'package.json': VALID_PACKAGE_JSON,
    });
    const res = await postZip(app, '/api/install/plugin', zip);
    expect(res.status).toBe(400);
  });

  it('rejects overwrite (target exists)', async () => {
    const app = createTestApp();
    // Simulate a previously-installed plugin: the dir is non-empty.
    const existingDir = path.join(pluginsDir, 'plugin-test-plugin');
    await mkdir(existingDir, { recursive: true });
    await writeFile(path.join(existingDir, 'marker.txt'), 'existing-install');

    const zip = await buildZip({
      'PLUGIN.md': VALID_PLUGIN_MD,
      'package.json': VALID_PACKAGE_JSON,
    });
    const res = await postZip(app, '/api/install/plugin', zip);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/already exists/);

    // Existing install must still be intact (not stomped by a failed rename).
    await expect(readFile(path.join(existingDir, 'marker.txt'), 'utf-8'))
      .resolves.toBe('existing-install');
  });

  it('rejects request without multipart file', async () => {
    const app = createTestApp();
    const res = await app.request('/api/install/plugin', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(400);
  });

  it('rejects oversized Content-Length before parsing body (413)', async () => {
    const app = createTestApp();
    const res = await app.request('/api/install/plugin', {
      method: 'POST',
      headers: {
        // 100 MB — above the 20 MB cap.
        'content-length': String(100 * 1024 * 1024),
        'content-type': 'multipart/form-data; boundary=----covel-test',
      },
      // An empty body is fine; the handler should reject before reading it.
      body: '------covel-test--\r\n',
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/exceeds/);
  });

  it('rejects mismatched plugin id (package.json name ≠ PLUGIN.md name)', async () => {
    const app = createTestApp();
    const mismatched = VALID_PLUGIN_MD.replace('name: test-plugin', 'name: other-plugin');
    const zip = await buildZip({
      'PLUGIN.md': mismatched,
      'package.json': VALID_PACKAGE_JSON,
    });
    const res = await postZip(app, '/api/install/plugin', zip);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/mismatch|plugin id/i);
  });

  it('rejects symlink entries', async () => {
    const app = createTestApp();
    // yazl doesn't expose `mode`, so we craft a symlink entry using addReadStream-style
    // metadata. Easiest path: encode Unix mode bits directly via the low-level API by
    // mutating externalFileAttributes after the fact is tricky; instead, we round-trip
    // through the yazl AST using the `mode` option on addBuffer (undocumented).
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(VALID_PACKAGE_JSON, 'utf-8'), 'package.json');
    zip.addBuffer(Buffer.from(VALID_PLUGIN_MD, 'utf-8'), 'PLUGIN.md');
    // Unix symlink: st_mode = 0o120000 | 0o644 = 0o120644 → externalFileAttributes = mode << 16.
    // yazl will set versionMadeBy to Unix (3) only when `mode` option is passed.
    zip.addBuffer(
      Buffer.from('/etc/passwd', 'utf-8'),
      'evil-link',
      { mode: 0o120644 } as unknown as { mode: number; mtime?: Date },
    );
    const zipBuf = await zipToBuffer(zip);

    const res = await postZip(app, '/api/install/plugin', zipBuf);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/unsupported entry type/);
  });

  it('rejects high-ratio zip bombs (uncompressed/compressed > 100x)', async () => {
    const app = createTestApp();
    // 2 MB of zeros compresses to < 10 KB with deflate — ratio ≫ 100x.
    const bombPayload = Buffer.alloc(2 * 1024 * 1024, 0);
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(VALID_PACKAGE_JSON, 'utf-8'), 'package.json');
    zip.addBuffer(Buffer.from(VALID_PLUGIN_MD, 'utf-8'), 'PLUGIN.md');
    zip.addBuffer(bombPayload, 'payload.bin');
    const zipBuf = await zipToBuffer(zip);

    const res = await postZip(app, '/api/install/plugin', zipBuf);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/ratio|expansion/i);
  });

  it('rejects non-zip uploads', async () => {
    const app = createTestApp();
    const notZip = Buffer.from('this is plainly not a zip file', 'utf-8');
    const res = await postZip(app, '/api/install/plugin', notZip);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('serialises concurrent installs of the same id (one 200, one 409)', async () => {
    const app = createTestApp();
    const zipA = await buildZip({
      'PLUGIN.md': VALID_PLUGIN_MD,
      'package.json': VALID_PACKAGE_JSON,
    });
    const zipB = await buildZip({
      'PLUGIN.md': VALID_PLUGIN_MD,
      'package.json': VALID_PACKAGE_JSON,
    });

    const [resA, resB] = await Promise.all([
      postZip(app, '/api/install/plugin', zipA),
      postZip(app, '/api/install/plugin', zipB),
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    // The winning install must leave a valid plugin on disk.
    const installed = path.join(pluginsDir, 'plugin-test-plugin', 'PLUGIN.md');
    await expect(readFile(installed, 'utf-8')).resolves.toContain('name: test-plugin');
  });
});

// ── World install ───────────────────────────────────────────────

describe('POST /api/install/world', () => {
  it('accepts a valid world package', async () => {
    const app = createTestApp();
    const zip = await buildZip({
      'world.yaml': VALID_WORLD_YAML,
      'WORLD.md': VALID_WORLD_MD,
    });
    const res = await postZip(app, '/api/install/world', zip);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; id: string; restartRequired: boolean };
    expect(body.ok).toBe(true);
    expect(body.id).toBe('test-world');
    expect(body.restartRequired).toBe(false);
    expect(await dirExists(path.join(worldsDir, 'test-world'))).toBe(true);
  });

  it('rejects missing world.yaml', async () => {
    const app = createTestApp();
    const zip = await buildZip({
      'WORLD.md': 'hello',
    });
    const res = await postZip(app, '/api/install/world', zip);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/world\.yaml/);
  });

  it('rejects invalid world.yaml', async () => {
    const app = createTestApp();
    const zip = await buildZip({
      'world.yaml': 'id: bad\nname: Missing required fields\n',
      'WORLD.md': VALID_WORLD_MD,
    });
    const res = await postZip(app, '/api/install/world', zip);
    expect(res.status).toBe(400);
  });

  it('rejects overwrite', async () => {
    const app = createTestApp();
    const existingDir = path.join(worldsDir, 'test-world');
    await mkdir(existingDir, { recursive: true });
    await writeFile(path.join(existingDir, 'marker.txt'), 'existing-world');

    const zip = await buildZip({
      'world.yaml': VALID_WORLD_YAML,
      'WORLD.md': VALID_WORLD_MD,
    });
    const res = await postZip(app, '/api/install/world', zip);
    expect(res.status).toBe(409);
    await expect(readFile(path.join(existingDir, 'marker.txt'), 'utf-8'))
      .resolves.toBe('existing-world');
  });

  it('rejects zip-slip', async () => {
    const app = createTestApp();
    const zip = await buildZipWithRawEntries([
      { name: 'world.yaml', content: VALID_WORLD_YAML },
      { name: 'WORLD.md', content: VALID_WORLD_MD },
      { name: '/etc/absolute.txt', content: 'bad' },
    ]);
    const res = await postZip(app, '/api/install/world', zip);
    expect(res.status).toBe(400);
  });
});
