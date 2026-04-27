/**
 * Regression tests for `dev-home-bootstrap`.
 *
 * The original bug: `setIfMissing` required the candidate to already exist on
 * disk, but the SQLite database file is a *runtime artifact* that the server
 * creates on first boot. The check therefore always failed for `SQLITE_PATH`,
 * silently leaving it unset and routing the database to the cwd-relative
 * fallback (`./data/covel.db` under `apps/server/`) instead of `~/.covel/data/`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'COVEL_HOME',
  'COVEL_USER_PLUGINS_DIR',
  'COVEL_USER_WORLDS_DIR',
  'COVEL_LLM_TOML',
  'SQLITE_PATH',
  'NODE_ENV',
  'COVEL_DESKTOP_REST',
  'COVEL_LOGS_DIR',
  'COVEL_SERVER_LOG_FILE',
];

// `dev-home-bootstrap` runs `bootstrap()` once at module init as a side effect.
// `vi.resetModules()` forces a re-evaluation so each test exercises the
// real import-time path against the env we set up in `beforeEach`. The
// exported `summary` captures that one canonical run — calling `bootstrap()`
// a second time would short-circuit on the now-set env vars.
async function freshBootstrap() {
  vi.resetModules();
  const mod = await import('../../src/dev-home-bootstrap.js');
  return mod.summary;
}

describe('dev-home-bootstrap', () => {
  let tmpHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'covel-home-'));
    process.env.COVEL_HOME = tmpHome;
    process.env.NODE_ENV = 'development';
    // Disable stdout/stderr tee so bootstrap() doesn't wrap real test
    // streams (which would persist across test files and corrupt output).
    process.env.COVEL_SERVER_LOG_FILE = '';
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('sets SQLITE_PATH even when the db file does not exist yet', async () => {
    const summary = await freshBootstrap();

    expect(summary.applied).toBe(true);
    expect(process.env.SQLITE_PATH).toBe(path.join(tmpHome, 'data', 'covel.db'));
    expect(summary.setVars).toContain('SQLITE_PATH');
  });

  it('creates the parent directory so the server can open the db', async () => {
    expect(fs.existsSync(path.join(tmpHome, 'data'))).toBe(false);

    await freshBootstrap();

    expect(fs.existsSync(path.join(tmpHome, 'data'))).toBe(true);
  });

  it('respects existing SQLITE_PATH and does not overwrite it', async () => {
    const userPath = path.join(tmpHome, 'custom.db');
    process.env.SQLITE_PATH = userPath;

    const summary = await freshBootstrap();

    expect(process.env.SQLITE_PATH).toBe(userPath);
    expect(summary.setVars).not.toContain('SQLITE_PATH');
  });

  it('skips user-provided resources that do not exist (plugins/worlds/llm.toml)', async () => {
    const summary = await freshBootstrap();

    expect(process.env.COVEL_USER_PLUGINS_DIR).toBeUndefined();
    expect(process.env.COVEL_USER_WORLDS_DIR).toBeUndefined();
    expect(process.env.COVEL_LLM_TOML).toBeUndefined();
    expect(summary.setVars).not.toContain('COVEL_USER_PLUGINS_DIR');
  });

  it('picks up user-provided resources when they exist on disk', async () => {
    fs.mkdirSync(path.join(tmpHome, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, 'worlds'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'llm.toml'), '# empty\n');

    await freshBootstrap();

    expect(process.env.COVEL_USER_PLUGINS_DIR).toBe(path.join(tmpHome, 'plugins'));
    expect(process.env.COVEL_USER_WORLDS_DIR).toBe(path.join(tmpHome, 'worlds'));
    expect(process.env.COVEL_LLM_TOML).toBe(path.join(tmpHome, 'llm.toml'));
  });

  it('is a no-op when the desktop sidecar marker is set', async () => {
    process.env.COVEL_DESKTOP_REST = '1';

    const summary = await freshBootstrap();

    expect(summary.applied).toBe(false);
    expect(summary.skipReason).toBe('desktop-sidecar');
    expect(process.env.SQLITE_PATH).toBeUndefined();
  });

  it('is a no-op in production', async () => {
    process.env.NODE_ENV = 'production';

    const summary = await freshBootstrap();

    expect(summary.applied).toBe(false);
    expect(summary.skipReason).toBe('production');
    expect(process.env.SQLITE_PATH).toBeUndefined();
  });

  it('is a no-op when ~/.covel does not exist', async () => {
    const missingHome = path.join(tmpHome, 'does-not-exist');
    process.env.COVEL_HOME = missingHome;

    const summary = await freshBootstrap();

    expect(summary.applied).toBe(false);
    expect(summary.skipReason).toBe('no-covel-home');
    expect(process.env.SQLITE_PATH).toBeUndefined();
  });
});
