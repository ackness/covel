/**
 * Tests for session plugin enable/disable routes (V1 compat paths in app.ts).
 *
 * Covers:
 * - H1: core-plugin cannot be disabled
 * - H3: body validation on enable/disable routes
 *
 * Since the routes are inline in app.ts (not extracted to a route module),
 * we recreate the same route logic with test dependencies.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginSummary,
  type PluginRegistryEntry,
} from '@covel/plugin-loader';
import { createMemoryStore, type DataStore } from '@covel/store';

// ── Helpers ──────────────────────────────────────────────────────

function makeSummary(overrides?: Partial<PluginSummary>): PluginSummary {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    description: 'A test plugin',
    pluginType: 'plugin',
    runtimeCount: 1,
    ...overrides,
  };
}

function makeEntry(overrides?: Partial<PluginRegistryEntry>): PluginRegistryEntry {
  return {
    id: 'test-plugin',
    summary: makeSummary(),
    loadedRuntimes: new Map(),
    status: 'registered',
    ...overrides,
  };
}

/**
 * Creates a test app with the same session plugin enable/disable routes
 * as app.ts, so we can test the logic without bootstrapping the real server.
 */
function createTestApp(registry: PluginRegistry, store: DataStore): Hono {
  const app = new Hono();

  app.get('/sessions/:id/plugins', async (c) => {
    const id = c.req.param('id');
    const session = await store.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const allPlugins = registry.getAll();
    const activeSet = new Set(session.activePlugins);
    const available = [...allPlugins.values()].map((entry) => ({
      id: entry.id,
      displayName: entry.summary.name,
      description: entry.summary.description,
      isActive: activeSet.has(entry.id),
      locked: entry.summary.pluginType === 'core-plugin',
    }));
    return c.json({ active: [...session.activePlugins], available });
  });

  app.post('/sessions/:id/plugins/enable', async (c) => {
    const id = c.req.param('id');
    // H3: Validate request body
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const pluginId = body.pluginId;
    if (typeof pluginId !== 'string' || !pluginId) {
      return c.json({ error: 'pluginId must be a non-empty string' }, 400);
    }
    const session = await store.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (!registry.get(pluginId)) {
      return c.json({ error: 'Plugin not found' }, 404);
    }
    const activeSet = new Set(session.activePlugins);
    if (!activeSet.has(pluginId)) {
      activeSet.add(pluginId);
      await store.updateSession(id, { activePlugins: [...activeSet] });
      registry.activate(pluginId, id);
    }
    return c.json({ ok: true, activePlugins: [...activeSet] });
  });

  app.post('/sessions/:id/plugins/disable', async (c) => {
    const id = c.req.param('id');
    // H3: Validate request body
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const pluginId = body.pluginId;
    if (typeof pluginId !== 'string' || !pluginId) {
      return c.json({ error: 'pluginId must be a non-empty string' }, 400);
    }
    const session = await store.getSession(id);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    // H1: Prevent disabling core plugins
    const entry = registry.get(pluginId);
    if (entry && entry.summary.pluginType === 'core-plugin') {
      return c.json({ error: 'Cannot disable core plugin' }, 403);
    }
    const activeSet = new Set(session.activePlugins);
    if (activeSet.has(pluginId)) {
      activeSet.delete(pluginId);
      await store.updateSession(id, { activePlugins: [...activeSet] });
      registry.deactivate(pluginId, id);
    }
    return c.json({ ok: true, activePlugins: [...activeSet] });
  });

  return app;
}

// ── Tests ────────────────────────────────────────────────────────

describe('Session plugin routes', () => {
  let registry: PluginRegistry;
  let store: DataStore;
  let app: Hono;
  const SESSION_ID = 'sess-1';

  beforeEach(async () => {
    registry = createPluginRegistry();
    store = createMemoryStore();
    app = createTestApp(registry, store);

    // Register plugins
    registry.register(makeEntry({
      id: 'core-narrator',
      summary: makeSummary({ id: 'core-narrator', name: 'Core Narrator', pluginType: 'core-plugin' }),
    }));
    registry.register(makeEntry({
      id: 'optional-plugin',
      summary: makeSummary({ id: 'optional-plugin', name: 'Optional Plugin', pluginType: 'plugin' }),
    }));

    // Create a session with both plugins active
    await store.createSession({
      id: SESSION_ID,
      worldId: null,
      status: 'active',
      phase: 'playing',
      presetId: null,
      activePlugins: ['core-narrator', 'optional-plugin'],
      createdAt: new Date().toISOString(),
    });
  });

  describe('H1: core-plugin cannot be disabled', () => {
    it('should return 403 when attempting to disable a core-plugin', async () => {
      const res = await app.request(`/sessions/${SESSION_ID}/plugins/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: 'core-narrator' }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('core');
    });

    it('should allow disabling a non-core plugin', async () => {
      const res = await app.request(`/sessions/${SESSION_ID}/plugins/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: 'optional-plugin' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect((body.activePlugins as string[])).not.toContain('optional-plugin');
    });

    it('should still include core-narrator in active list after failed disable', async () => {
      await app.request(`/sessions/${SESSION_ID}/plugins/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: 'core-narrator' }),
      });
      const session = await store.getSession(SESSION_ID);
      expect(session!.activePlugins).toContain('core-narrator');
    });
  });

  describe('H3: body validation on enable/disable routes', () => {
    it('should return 400 when enable body is not valid JSON', async () => {
      const res = await app.request(`/sessions/${SESSION_ID}/plugins/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });

    it('should return 400 when disable body is not valid JSON', async () => {
      const res = await app.request(`/sessions/${SESSION_ID}/plugins/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });

    it('should return 400 when pluginId is missing in enable body', async () => {
      const res = await app.request(`/sessions/${SESSION_ID}/plugins/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('pluginId');
    });

    it('should return 400 when pluginId is missing in disable body', async () => {
      const res = await app.request(`/sessions/${SESSION_ID}/plugins/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('pluginId');
    });

    it('should return 400 when pluginId is not a string', async () => {
      const res = await app.request(`/sessions/${SESSION_ID}/plugins/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: 123 }),
      });
      expect(res.status).toBe(400);
    });

    it('should return 400 when pluginId is empty string', async () => {
      const res = await app.request(`/sessions/${SESSION_ID}/plugins/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: '' }),
      });
      expect(res.status).toBe(400);
    });
  });
});
