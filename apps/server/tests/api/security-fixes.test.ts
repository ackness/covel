/**
 * TDD tests for code review fixes (CRITICAL + HIGH issues).
 *
 * RED phase: all tests should FAIL before fixes are applied.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createStateManager, type StateManager } from '@covel/state';
import { createPluginRegistry, type PluginRegistry } from '@covel/plugin-loader';
import { createMemoryStore, type DataStore } from '@covel/store';
import { sessionRoutes } from '../../src/routes/api/session.js';
import { stateRoutes } from '../../src/routes/api/state.js';

// ── Helpers ─────────────────────────────────────────────────────

function createTestApp(deps: {
  store: DataStore;
  stateManager: StateManager;
  pluginRegistry: PluginRegistry;
}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('store', deps.store);
    c.set('stateManager', deps.stateManager);
    c.set('pluginRegistry', deps.pluginRegistry);
    await next();
  });
  app.route('/api/sessions', sessionRoutes);
  app.route('/api/sessions', stateRoutes);
  return app;
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

async function createSession(app: Hono, body: Record<string, unknown> = {}) {
  const res = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return json(res) as Promise<{ id: string }>;
}

// ── CRITICAL #1: Client-supplied session ID validation ──────────

describe('[HIGH] Client-supplied session ID validation', () => {
  let app: Hono;

  beforeEach(() => {
    const store = createMemoryStore();
    app = createTestApp({
      store,
      stateManager: createStateManager(store),
      pluginRegistry: createPluginRegistry(),
    });
  });

  it('rejects session ID with path traversal characters', async () => {
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '../../etc/passwd' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects session ID with special characters', async () => {
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '<script>alert(1)</script>' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects session ID exceeding max length', async () => {
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'a'.repeat(129) }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts valid custom session ID', async () => {
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'my-custom-session-01' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res) as { id: string };
    expect(body.id).toBe('my-custom-session-01');
  });
});

// ── CRITICAL #2: PUT /state-snapshot must not silently discard ───

describe('[CRITICAL] PUT /state-snapshot returns 501', () => {
  let app: Hono;

  beforeEach(() => {
    const store = createMemoryStore();
    app = createTestApp({
      store,
      stateManager: createStateManager(store),
      pluginRegistry: createPluginRegistry(),
    });
  });

  it('returns 501 Not Implemented instead of silent 200', async () => {
    const { id } = await createSession(app);
    const res = await app.request(`/api/sessions/${id}/state-snapshot`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character: { hp: 100 } }),
    });
    // Must NOT return 200 ok: true (silent discard)
    expect(res.status).toBe(501);
    const body = await json(res) as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });
});

// ── HIGH: plugins/disable must validate pluginId ────────────────

describe('[HIGH] plugins/disable validates pluginId', () => {
  let app: Hono;

  beforeEach(() => {
    const store = createMemoryStore();
    app = createTestApp({
      store,
      stateManager: createStateManager(store),
      pluginRegistry: createPluginRegistry(),
    });
  });

  it('rejects missing pluginId', async () => {
    const { id } = await createSession(app);
    const res = await app.request(`/api/sessions/${id}/plugins/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty pluginId', async () => {
    const { id } = await createSession(app);
    const res = await app.request(`/api/sessions/${id}/plugins/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginId: '' }),
    });
    expect(res.status).toBe(400);
  });
});

// ── HIGH: state-patches IDs must be stable ──────────────────────

describe('[HIGH] state-patches returns stable IDs', () => {
  let app: Hono;
  let stateManager: StateManager;

  beforeEach(async () => {
    const store = createMemoryStore();
    stateManager = createStateManager(store);
    app = createTestApp({
      store,
      stateManager,
      pluginRegistry: createPluginRegistry(),
    });
  });

  it('generates unique IDs with timestamp, not array index', async () => {
    const { id } = await createSession(app);

    await stateManager.createTable(id, {
      name: 'character',
      fields: [{ name: 'hp', type: 'integer', default: 100 }],
    });
    await stateManager.setValue(id, 'character', 'hp', 80, {
      changedBy: 'test',
      turnId: 'turn-1',
      reason: 'damage',
    });

    const res = await app.request(`/api/sessions/${id}/state-patches`);
    expect(res.status).toBe(200);
    const patches = await json(res) as Array<{ id: string; createdAt: string }>;
    expect(patches).toHaveLength(1);
    // ID should NOT be "character.hp.0" (array index pattern)
    expect(patches[0].id).not.toMatch(/\.\d+$/);
    // ID should contain a timestamp or be otherwise stable
    expect(patches[0].createdAt).toBeDefined();
  });
});

// ── HIGH: POST /sessions activate-after-persist ordering ────────

describe('[HIGH] Plugin activation happens after session persist', () => {
  let app: Hono;
  let store: DataStore;
  let pluginRegistry: PluginRegistry;

  beforeEach(() => {
    store = createMemoryStore();
    pluginRegistry = createPluginRegistry();
    app = createTestApp({
      store,
      stateManager: createStateManager(store),
      pluginRegistry,
    });
  });

  it('session exists in store when plugins array is non-empty', async () => {
    // Register a mock plugin so activate doesn't silently skip
    pluginRegistry.register({
      id: 'test-plugin',
      summary: { id: 'test-plugin', name: 'Test', description: '', pluginType: 'plugin', runtimeCount: 0 },
      loadedRuntimes: new Map(),
      status: 'registered',
    });

    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: ['test-plugin'] }),
    });
    expect(res.status).toBe(200);

    const body = await json(res) as { id: string; activePlugins: string[] };
    // Session must be persisted
    const session = await store.getSession(body.id);
    expect(session).not.toBeNull();
    expect(session!.activePlugins).toContain('test-plugin');
  });
});
