/**
 * V2 Plugin and Turn route tests.
 *
 * Uses Hono's app.request() for lightweight HTTP testing without a running server.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { pluginRoutes } from '../../src/routes/v2/plugins.js';
import { turnRoutes } from '../../src/routes/v2/turn.js';
import {
  createPluginRegistry,
  createSessionScope,
  type PluginRegistry,
  type SessionPluginScope,
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

function makeEntryWithConfig(
  pluginId: string,
  config: Record<string, unknown>,
): PluginRegistryEntry {
  return {
    id: pluginId,
    summary: makeSummary({ id: pluginId, name: pluginId }),
    manifest: {
      manifest: {
        name: pluginId,
        description: 'Plugin with config',
        priority: 500,
        config: config as never,
      },
      promptTemplate: '',
      referenceLinks: [],
      rawFrontmatter: {},
    },
    loadedRuntimes: new Map(),
    status: 'registered',
  };
}

// ── App factory ──────────────────────────────────────────────────

type AppVariables = {
  pluginRegistry: PluginRegistry;
  sessionScopes: Map<string, SessionPluginScope>;
  store: DataStore;
};

function createTestApp(vars: AppVariables): Hono {
  const app = new Hono();

  // Inject dependencies via middleware
  app.use('*', async (c, next) => {
    c.set('pluginRegistry' as never, vars.pluginRegistry);
    c.set('sessionScopes' as never, vars.sessionScopes);
    c.set('store' as never, vars.store);
    await next();
  });

  app.route('/v2/plugins', pluginRoutes);
  app.route('/v2/session', turnRoutes);
  return app;
}

// ── Plugin route tests ───────────────────────────────────────────

describe('V2 Plugin Routes', () => {
  let registry: PluginRegistry;
  let sessionScopes: Map<string, SessionPluginScope>;
  let store: DataStore;
  let app: Hono;

  beforeEach(() => {
    registry = createPluginRegistry();
    sessionScopes = new Map();
    store = createMemoryStore();
    app = createTestApp({ pluginRegistry: registry, sessionScopes, store });
  });

  describe('GET /v2/plugins', () => {
    it('should return empty array when no plugins registered', async () => {
      const res = await app.request('/v2/plugins');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ plugins: [] });
    });

    it('should return all registered plugins', async () => {
      registry.register(makeEntry({ id: 'plugin-a', summary: makeSummary({ id: 'plugin-a', name: 'Plugin A' }) }));
      registry.register(makeEntry({ id: 'plugin-b', summary: makeSummary({ id: 'plugin-b', name: 'Plugin B' }) }));

      const res = await app.request('/v2/plugins');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.plugins).toHaveLength(2);
      expect(body.plugins[0]).toMatchObject({ id: 'plugin-a', name: 'Plugin A' });
      expect(body.plugins[1]).toMatchObject({ id: 'plugin-b', name: 'Plugin B' });
    });
  });

  describe('GET /v2/plugins/:id', () => {
    it('should return plugin details when found', async () => {
      registry.register(makeEntry({ id: 'my-plugin', summary: makeSummary({ id: 'my-plugin', name: 'My Plugin' }) }));

      const res = await app.request('/v2/plugins/my-plugin');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('my-plugin');
      expect(body.name).toBe('My Plugin');
      expect(body.status).toBe('registered');
    });

    it('should return 404 when plugin not found', async () => {
      const res = await app.request('/v2/plugins/nonexistent');
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe('GET /v2/plugins/:id/config', () => {
    it('should return config schema when plugin has config', async () => {
      const configSchema = {
        difficulty: { type: 'enum', options: ['easy', 'hard'], default: 'easy' },
        maxTurns: { type: 'integer', min: 1, max: 100, default: 10 },
      };
      registry.register(makeEntryWithConfig('cfg-plugin', configSchema));

      const res = await app.request('/v2/plugins/cfg-plugin/config');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pluginId).toBe('cfg-plugin');
      expect(body.config).toEqual(configSchema);
    });

    it('should return empty config when plugin has no config', async () => {
      registry.register(makeEntry({ id: 'no-cfg' , summary: makeSummary({ id: 'no-cfg' }) }));

      const res = await app.request('/v2/plugins/no-cfg/config');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pluginId).toBe('no-cfg');
      expect(body.config).toEqual({});
    });

    it('should return 404 when plugin not found', async () => {
      const res = await app.request('/v2/plugins/ghost/config');
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /v2/plugins/:id/config', () => {
    it('should update config via SessionPluginScope', async () => {
      registry.register(makeEntry({ id: 'cfg-plugin', summary: makeSummary({ id: 'cfg-plugin' }) }));
      const scope = createSessionScope('sess-1', ['cfg-plugin'], new Set());
      sessionScopes.set('sess-1', scope);

      const res = await app.request('/v2/plugins/cfg-plugin/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-1', config: { difficulty: 'hard' } }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(true);

      // Verify through scope
      expect(scope.getEffectiveConfig('cfg-plugin')).toEqual({ difficulty: 'hard' });
    });

    it('should return 404 when plugin not found', async () => {
      const scope = createSessionScope('sess-1', [], new Set());
      sessionScopes.set('sess-1', scope);

      const res = await app.request('/v2/plugins/ghost/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-1', config: { x: 1 } }),
      });
      expect(res.status).toBe(404);
    });

    it('should return 404 when session not found', async () => {
      registry.register(makeEntry({ id: 'cfg-plugin', summary: makeSummary({ id: 'cfg-plugin' }) }));

      const res = await app.request('/v2/plugins/cfg-plugin/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'no-session', config: { x: 1 } }),
      });
      expect(res.status).toBe(404);
    });
  });
});

// ── Turn route tests ─────────────────────────────────────────────

describe('V2 Turn Routes', () => {
  let registry: PluginRegistry;
  let sessionScopes: Map<string, SessionPluginScope>;
  let store: DataStore;
  let app: Hono;

  beforeEach(() => {
    registry = createPluginRegistry();
    sessionScopes = new Map();
    store = createMemoryStore();
    app = createTestApp({ pluginRegistry: registry, sessionScopes, store });
  });

  describe('POST /v2/session/:id/turn', () => {
    it('should return 404 for unknown session', async () => {
      const res = await app.request('/v2/session/unknown-sess/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe('GET /v2/session/:id/results', () => {
    it('should return empty results when no turns executed', async () => {
      const res = await app.request('/v2/session/sess-1/results');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([]);
    });
  });

  describe('GET /v2/session/:id/turns', () => {
    it('should return empty turns for session with no turns', async () => {
      const res = await app.request('/v2/session/sess-1/turns');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.turns).toEqual([]);
    });
  });
});
