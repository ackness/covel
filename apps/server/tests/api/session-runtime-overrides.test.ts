/**
 * PR-6: PATCH /api/sessions/:id runtimeModelOverrides field.
 *
 * Verifies the new payload shape is validated, persisted, and returned.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  createMemoryStore,
  type DataStore,
  type SessionRecord,
} from '@covel/store';
import {
  createPluginRegistry,
  type PluginRegistry,
} from '@covel/plugin-loader';
import { sessionRoutes } from '../../src/routes/api/session.js';

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
  };
};

function setupApp(store: DataStore, pluginRegistry: PluginRegistry): Hono {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('store', store);
    c.set('pluginRegistry', pluginRegistry);
    await next();
  });
  app.route('/api/sessions', sessionRoutes);
  return app;
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: 'sess-overrides-1',
    worldId: 'cloudmere',
    phase: 'playing',
    turnCount: 3,
    locale: 'zh-CN',
    activePlugins: ['core-narrator'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('PATCH /api/sessions/:id runtimeModelOverrides (PR-6)', () => {
  let store: DataStore;
  let app: Hono;

  beforeEach(async () => {
    store = createMemoryStore();
    const registry = createPluginRegistry();
    app = setupApp(store, registry);
    await store.createSession(makeSession());
  });

  it('persists runtimeModelOverrides through PATCH', async () => {
    const res = await app.request('/api/sessions/sess-overrides-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtimeModelOverrides: {
          'core-narrator': 'balance',
          'core-codex/unlocker': 'fast',
        },
      }),
    });
    expect(res.status).toBe(200);

    const fresh = await store.getSession('sess-overrides-1');
    expect(fresh?.runtimeModelOverrides).toEqual({
      'core-narrator': 'balance',
      'core-codex/unlocker': 'fast',
    });
  });

  it('strips empty / non-string entries before persisting', async () => {
    const res = await app.request('/api/sessions/sess-overrides-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtimeModelOverrides: {
          'core-narrator': 'balance',
          '': 'fast',
          'core-codex': 123,
          'core-guide': '',
        },
      }),
    });
    expect(res.status).toBe(200);

    const fresh = await store.getSession('sess-overrides-1');
    expect(fresh?.runtimeModelOverrides).toEqual({
      'core-narrator': 'balance',
    });
  });

  it('rejects null runtimeModelOverrides with 400', async () => {
    const res = await app.request('/api/sessions/sess-overrides-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtimeModelOverrides: null }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects array-shaped runtimeModelOverrides with 400', async () => {
    const res = await app.request('/api/sessions/sess-overrides-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtimeModelOverrides: ['fast'] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects more than 64 entries (MEDIUM-3)', async () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 65; i++) big[`runtime-${i}`] = 'fast';
    const res = await app.request('/api/sessions/sess-overrides-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtimeModelOverrides: big }),
    });
    expect(res.status).toBe(400);
  });

  it('strips entries with non-runtime-ID keys (MEDIUM-3)', async () => {
    const res = await app.request('/api/sessions/sess-overrides-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtimeModelOverrides: {
          'core-narrator': 'balance',
          '<script>alert(1)</script>': 'fast',
          'Bad-Caps': 'fast',
          'core-codex/unlocker': 'fast',
        },
      }),
    });
    expect(res.status).toBe(200);

    const fresh = await store.getSession('sess-overrides-1');
    expect(fresh?.runtimeModelOverrides).toEqual({
      'core-narrator': 'balance',
      'core-codex/unlocker': 'fast',
    });
  });

  it('rejects invalid phase value with 400 (MEDIUM-2)', async () => {
    const res = await app.request('/api/sessions/sess-overrides-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'not-a-real-phase' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts a valid phase value (MEDIUM-2)', async () => {
    const res = await app.request('/api/sessions/sess-overrides-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'paused' }),
    });
    expect(res.status).toBe(200);
    const fresh = await store.getSession('sess-overrides-1');
    expect(fresh?.phase).toBe('paused');
  });

  it('clearing with empty object removes overrides', async () => {
    await store.updateSession('sess-overrides-1', {
      runtimeModelOverrides: { 'core-narrator': 'fast' },
      updatedAt: new Date().toISOString(),
    });

    const res = await app.request('/api/sessions/sess-overrides-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtimeModelOverrides: {} }),
    });
    expect(res.status).toBe(200);

    const fresh = await store.getSession('sess-overrides-1');
    expect(
      fresh?.runtimeModelOverrides === undefined
        || Object.keys(fresh?.runtimeModelOverrides ?? {}).length === 0,
    ).toBe(true);
  });
});
