/**
 * Plugin Data REST API compatibility tests.
 *
 * The Web UI currently consumes GET/list. PUT/DELETE are retained as
 * management/API write endpoints and should remain compatible unless they go
 * through an explicit deprecation cycle.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createPluginRegistry, type ParsedPluginManifest, type PluginRegistry } from '@covel/plugin-loader';
import type { RuntimeManifest } from '@covel/shared';
import { createMemoryStore, type DataStore } from '@covel/store';
import { pluginDataRoutes } from '../../src/routes/api/plugin-data.js';

function buildApp(store: DataStore, pluginRegistry: PluginRegistry): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('store', store);
    c.set('pluginRegistry', pluginRegistry);
    await next();
  });
  app.route('/api/sessions', pluginDataRoutes);
  return app;
}

function makeManifest(pluginId: string): RuntimeManifest {
  return {
    name: pluginId,
    pluginId,
    runtime: 'agent',
    description: `${pluginId} runtime`,
    trigger: { mode: 'manual' },
    priority: 500,
    tools: { builtin: [], local: [] },
    permissions: [],
    outputKind: 'plugin',
  };
}

function registerPlugin(registry: PluginRegistry, pluginId = 'test-plugin'): void {
  const manifest = makeManifest(pluginId);
  const parsed: ParsedPluginManifest = { manifest, rawFrontmatter: {}, markdown: '' };
  registry.register({
    id: pluginId,
    summary: { id: pluginId, name: 'Test Plugin', description: '', pluginType: 'plugin', runtimeCount: 1 },
    loadedRuntimes: new Map(),
    status: 'registered',
    manifest: parsed,
    manifests: [parsed],
  });
}

describe('Plugin Data REST API routes', () => {
  let store: DataStore;
  let registry: PluginRegistry;
  let app: Hono;
  const sessionId = 'sess-plugin-data';
  const pluginId = 'test-plugin';

  beforeEach(async () => {
    store = createMemoryStore();
    registry = createPluginRegistry();
    registerPlugin(registry, pluginId);
    registry.activate(pluginId, sessionId);
    app = buildApp(store, registry);

    await store.createSession({
      id: sessionId,
      worldId: 'cloudmere',
      status: 'active',
      turnCount: 1,
      preGameCompleted: [],
      locale: 'zh-CN',
      activePlugins: [pluginId],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  it('PUT writes a value and GET returns it', async () => {
    const putRes = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/settings/theme`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: { mode: 'dark' } }),
      },
    );
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ success: true, namespace: 'settings', key: 'theme' });

    const getRes = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/settings/theme`,
    );
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as Record<string, unknown>;
    expect(body).toMatchObject({ namespace: 'settings', key: 'theme', value: { mode: 'dark' } });
  });

  it('DELETE removes a value', async () => {
    await store.setPluginData({
      id: 'pd-1',
      sessionId,
      pluginId,
      namespace: 'entries',
      key: 'k1',
      value: { hello: 'world' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const delRes = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/entries/k1`,
      { method: 'DELETE' },
    );
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ success: true });

    const getRes = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/entries/k1`,
    );
    expect(getRes.status).toBe(404);
  });

  it('PUT validates body shape and payload size', async () => {
    const missingValue = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/settings/bad`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nope: true }),
      },
    );
    expect(missingValue.status).toBe(400);

    const tooLarge = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/settings/large`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(65_537) }),
      },
    );
    expect(tooLarge.status).toBe(413);
  });

  it('write operations require the plugin to be active in the session', async () => {
    const inactivePlugin = 'inactive-plugin';
    registerPlugin(registry, inactivePlugin);

    const res = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${inactivePlugin}/settings/theme`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: true }),
      },
    );
    expect(res.status).toBe(403);
  });
});
