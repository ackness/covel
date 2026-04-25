/**
 * Tests for session plugin enable/disable routes.
 *
 * Mounts the REAL sessionRoutes from src/routes/api/session.ts so we test
 * production code, not a hand-copied shadow. (Fix for 2026-04-12 audit
 * Finding 5: the previous version of this file declared its own Hono routes
 * inline that drifted from the real implementation.)
 *
 * Covers:
 * - H1: core-plugin cannot be disabled (enforced by manifest.pluginType,
 *       not hardcoded plugin IDs — see CLAUDE.md framework-plugin isolation)
 * - H3: pluginId body validation
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
import { sessionRoutes } from '../../src/routes/api/session.js';

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
 * Mount the real sessionRoutes module under /api/sessions, mirroring how
 * bootstrap.ts wires it. Tests then exercise production behavior 1:1.
 */
function createTestApp(registry: PluginRegistry, store: DataStore): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('store', store);
    c.set('pluginRegistry', registry);
    await next();
  });
  app.route('/api/sessions', sessionRoutes);
  return app;
}

// ── Tests ────────────────────────────────────────────────────────

describe('Session plugin routes (real sessionRoutes)', () => {
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
      turnCount: 1,
      preGameCompleted: [],
      presetId: null,
      activePlugins: ['core-narrator', 'optional-plugin'],
      createdAt: new Date().toISOString(),
    });
  });

  describe('H1: core-plugin cannot be disabled', () => {
    it('includes required core plugins when creating a session from a partial plugin list', async () => {
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'sess-core-create',
          plugins: ['optional-plugin'],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { activePlugins: string[] };
      expect(body.activePlugins).toEqual(expect.arrayContaining(['core-narrator', 'optional-plugin']));

      const session = await store.getSession('sess-core-create');
      expect(session?.activePlugins).toEqual(expect.arrayContaining(['core-narrator', 'optional-plugin']));
    });

    it('should return 403 when attempting to disable a core-plugin', async () => {
      const res = await app.request(`/api/sessions/${SESSION_ID}/plugins/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: 'core-narrator' }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/core/i);
    });

    it('should allow disabling a non-core plugin', async () => {
      const res = await app.request(`/api/sessions/${SESSION_ID}/plugins/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: 'optional-plugin' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      // Real route returns `active`, not `activePlugins`
      expect((body.active as string[])).not.toContain('optional-plugin');
    });

    it('should still include core-narrator in active list after failed disable', async () => {
      await app.request(`/api/sessions/${SESSION_ID}/plugins/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: 'core-narrator' }),
      });
      const session = await store.getSession(SESSION_ID);
      expect(session!.activePlugins).toContain('core-narrator');
    });

    it('uses discovery trust metadata when deciding whether a plugin is core', async () => {
      registry.register(makeEntry({
        id: 'forged-core',
        summary: makeSummary({ id: 'forged-core', name: 'Forged Core', pluginType: 'core-plugin' }),
        source: 'community',
      }));
      await store.updateSession(SESSION_ID, {
        activePlugins: ['core-narrator', 'optional-plugin', 'forged-core'],
        updatedAt: new Date().toISOString(),
      });

      const res = await app.request(`/api/sessions/${SESSION_ID}/plugins/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: 'forged-core' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { active: string[] };
      expect(body.active).toEqual(['core-narrator', 'optional-plugin']);
    });
  });

  describe('H3: pluginId validation on disable route', () => {
    it('should return 400 when pluginId is missing in disable body', async () => {
      const res = await app.request(`/api/sessions/${SESSION_ID}/plugins/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/pluginId/);
    });

    it('should return 404 when session does not exist', async () => {
      const res = await app.request(`/api/sessions/no-such-session/plugins/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: 'optional-plugin' }),
      });
      expect(res.status).toBe(404);
    });
  });
});
