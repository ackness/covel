/**
 * Session, State, and Health route tests.
 *
 * Tests use Hono's `app.request()` with dependency injection via context variables.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createStateManager, type StateManager } from '@covel/state';
import { createPluginRegistry, type PluginRegistry } from '@covel/plugin-loader';
import { createMemoryStore, type DataStore } from '@covel/store';
import { sessionRoutes } from '../../src/routes/api/session.js';
import { stateRoutes } from '../../src/routes/api/state.js';
import { createHealthRoutes } from '../../src/routes/api/health.js';

// ── Helpers ─────────────────────────────────────────────────────────

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
  app.route('/api/health', createHealthRoutes(deps.store, 'memory'));

  return app;
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Health Route', () => {
  it('returns status ok and version 1.0.0', async () => {
    const memStore = createMemoryStore();
    const app = createTestApp({
      store: memStore,
      stateManager: createStateManager(memStore),
      pluginRegistry: createPluginRegistry(),
    });

    const res = await app.request('/api/health');
    expect(res.status).toBe(200);

    const body = await json(res) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.0.0');
  });
});

describe('Session Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let store: DataStore;
  let stateManager: StateManager;
  let pluginRegistry: PluginRegistry;

  beforeEach(() => {
    store = createMemoryStore();
    stateManager = createStateManager(store);
    pluginRegistry = createPluginRegistry();
    app = createTestApp({ store, stateManager, pluginRegistry });
  });

  describe('POST /api/sessions', () => {
    it('creates a new session and returns full record', async () => {
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worldId: 'cloudmere', locale: 'en-US' }),
      });

      expect(res.status).toBe(200);

      const body = await json(res) as Record<string, unknown>;
      expect(body.id).toBeDefined();
      expect(typeof body.id).toBe('string');
      expect(body.phase).toBe('pre-game');
      expect(body.activePlugins).toEqual([]);
    });

    it('stores the session in the data store', async () => {
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const body = await json(res) as Record<string, unknown>;
      const sessionId = body.id as string;

      const session = await store.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.phase).toBe('pre-game');
      expect(session!.turnCount).toBe(0);
    });

    it('rejects worldId with invalid characters', async () => {
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worldId: '../../etc' }),
      });

      expect(res.status).toBe(400);
      const body = await json(res) as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });

    it('rejects worldId with special characters', async () => {
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worldId: '<script>alert(1)</script>' }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects worldId exceeding max length', async () => {
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worldId: 'a'.repeat(65) }),
      });

      expect(res.status).toBe(400);
    });

    it('generates non-sequential session IDs', async () => {
      // Create two sessions — IDs should not be predictable sequential numbers
      const res1 = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worldId: 'testworld' }),
      });
      const res2 = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worldId: 'testworld' }),
      });

      const body1 = await json(res1) as { id: string };
      const body2 = await json(res2) as { id: string };

      // Both should start with the worldId prefix
      expect(body1.id).toMatch(/^testworld-/);
      expect(body2.id).toMatch(/^testworld-/);

      // But should NOT be sequential numbers
      expect(body1.id).not.toBe('testworld-1');
      expect(body2.id).not.toBe('testworld-2');

      // And should be different from each other
      expect(body1.id).not.toBe(body2.id);
    });

    it('accepts optional plugins list', async () => {
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugins: ['core-narrator', 'core-combat'] }),
      });

      expect(res.status).toBe(200);
      const body = await json(res) as Record<string, unknown>;
      expect(body.activePlugins).toEqual(['core-narrator', 'core-combat']);
    });
  });

  describe('GET /api/sessions/:id', () => {
    it('returns session data for existing session', async () => {
      // Create session first
      const createRes = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worldId: 'mistport' }),
      });
      const { id: sessionId } = await json(createRes) as { id: string };

      // Get session
      const res = await app.request(`/api/sessions/${sessionId}`);
      expect(res.status).toBe(200);

      const body = await json(res) as Record<string, unknown>;
      expect(body.id).toBe(sessionId);
      expect(body.phase).toBe('pre-game');
      expect(body.worldId).toBe('mistport');
    });

    it('returns 404 for unknown session', async () => {
      const res = await app.request('/api/sessions/nonexistent');
      expect(res.status).toBe(404);

      const body = await json(res) as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });
  });

  describe('DELETE /api/sessions/:id', () => {
    it('deletes an existing session', async () => {
      // Create session first
      const createRes = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const { id: sessionId } = await json(createRes) as { id: string };

      // Delete session
      const res = await app.request(`/api/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);

      const body = await json(res) as Record<string, unknown>;
      expect(body.deleted).toBe(true);

      // Verify it's gone
      const session = await store.getSession(sessionId);
      expect(session).toBeNull();
    });

    it('returns 404 for unknown session', async () => {
      const res = await app.request('/api/sessions/nonexistent', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });
  });
});

describe('State Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let store: DataStore;
  let stateManager: StateManager;
  let pluginRegistry: PluginRegistry;
  let sessionId: string;

  beforeEach(async () => {
    store = createMemoryStore();
    stateManager = createStateManager(store);
    pluginRegistry = createPluginRegistry();
    app = createTestApp({ store, stateManager, pluginRegistry });

    // Create a session for state tests
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await json(res) as { id: string };
    sessionId = body.id;
  });

  describe('GET /api/sessions/:id/state', () => {
    it('returns empty tables when no state exists', async () => {
      const res = await app.request(`/api/sessions/${sessionId}/state`);
      expect(res.status).toBe(200);

      const body = await json(res) as Record<string, unknown>;
      expect(body.tables).toEqual({});
    });

    it('returns table data after creating a table', async () => {
      await stateManager.createTable(sessionId, {
        name: 'character',
        fields: [
          { name: 'hp', type: 'integer', default: 100 },
          { name: 'name', type: 'string', default: 'Hero' },
        ],
      });

      const res = await app.request(`/api/sessions/${sessionId}/state`);
      expect(res.status).toBe(200);

      const body = await json(res) as {
        tables: Record<string, { schema: unknown; data: Record<string, unknown> }>;
      };
      expect(body.tables.character).toBeDefined();
      expect(body.tables.character.data.hp).toBe(100);
      expect(body.tables.character.data.name).toBe('Hero');
      expect(body.tables.character.schema).toBeDefined();
    });

    it('returns 404 for unknown session', async () => {
      const res = await app.request('/api/sessions/nonexistent/state');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/sessions/:id/state/:table', () => {
    it('returns table snapshot', async () => {
      await stateManager.createTable(sessionId, {
        name: 'character',
        fields: [
          { name: 'hp', type: 'integer', default: 100 },
          { name: 'level', type: 'integer', default: 1 },
        ],
      });

      const res = await app.request(`/api/sessions/${sessionId}/state/character`);
      expect(res.status).toBe(200);

      const body = await json(res) as { table: string; data: Record<string, unknown> };
      expect(body.table).toBe('character');
      expect(body.data.hp).toBe(100);
      expect(body.data.level).toBe(1);
    });

    it('returns 404 for unknown table', async () => {
      const res = await app.request(`/api/sessions/${sessionId}/state/nonexistent`);
      expect(res.status).toBe(404);

      const body = await json(res) as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });

    it('returns 404 for unknown session', async () => {
      const res = await app.request('/api/sessions/nonexistent/state/character');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/sessions/:id/state/:table/:field/history', () => {
    it('returns change history for a field', async () => {
      await stateManager.createTable(sessionId, {
        name: 'character',
        fields: [{ name: 'hp', type: 'integer', default: 100 }],
      });

      await stateManager.setValue(sessionId, 'character', 'hp', 80, {
        changedBy: 'core-combat/combat-runtime',
        turnId: 'turn-1',
        reason: 'took damage',
      });

      await stateManager.setValue(sessionId, 'character', 'hp', 60, {
        changedBy: 'core-combat/combat-runtime',
        turnId: 'turn-2',
        reason: 'took more damage',
      });

      const res = await app.request(
        `/api/sessions/${sessionId}/state/character/hp/history`,
      );
      expect(res.status).toBe(200);

      const body = await json(res) as {
        table: string;
        field: string;
        history: Array<{ value: unknown; changedBy: string; turnId: string }>;
      };
      expect(body.table).toBe('character');
      expect(body.field).toBe('hp');
      expect(body.history).toHaveLength(2);
      expect(body.history[0].value).toBe(80);
      expect(body.history[1].value).toBe(60);
    });

    it('returns 404 for unknown table', async () => {
      const res = await app.request(
        `/api/sessions/${sessionId}/state/nonexistent/hp/history`,
      );
      expect(res.status).toBe(404);
    });

    it('returns 404 for unknown field', async () => {
      await stateManager.createTable(sessionId, {
        name: 'character',
        fields: [{ name: 'hp', type: 'integer', default: 100 }],
      });

      const res = await app.request(
        `/api/sessions/${sessionId}/state/character/nonexistent/history`,
      );
      expect(res.status).toBe(404);
    });

    it('returns 404 for unknown session', async () => {
      const res = await app.request(
        '/api/sessions/nonexistent/state/character/hp/history',
      );
      expect(res.status).toBe(404);
    });
  });
});
