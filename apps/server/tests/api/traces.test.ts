import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mediaRefSchema } from '@covel/shared';
import { createMemoryStore, type DataStore, type SessionRecord } from '@covel/store';
import { traceRoutes } from '../../src/routes/api/traces.js';

function makeApp(store: DataStore): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('store', store);
    await next();
  });
  app.route('/api/traces', traceRoutes);
  return app;
}

function makeSession(id: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    id,
    worldId: 'world-1',
    status: 'active',
    turnCount: 1,
    preGameCompleted: [],
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe('traceRoutes legacy asset adapter', () => {
  it('synthesizes asset.generated events from legacy plugin_data images', async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession('sess-legacy'));
    await store.setPluginData({
      id: 'pd-1',
      sessionId: 'sess-legacy',
      pluginId: 'image-plugin',
      namespace: 'images',
      key: 'img-1',
      value: {
        turnId: 'turn-1',
        imageUrl: 'https://example.test/legacy.png',
        mime: 'image/png',
        meta: { prompt: 'castle' },
      },
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    });

    const app = makeApp(store);
    const res = await app.request('/api/traces/sess-legacy');

    expect(res.status).toBe(200);
    const body = await res.json() as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const legacy = body.events.find((event) => event.type === 'asset.generated');
    expect(legacy?.payload.legacy).toBe(true);
    expect(legacy?.payload.asset).toMatchObject({
      type: 'asset.generate',
      sessionId: 'sess-legacy',
      turnId: 'turn-1',
      modality: 'image',
      ref: {
        mime: 'image/png',
        size: 0,
        url: 'https://example.test/legacy.png',
      },
    });
  });

  it('dedupes synthesized legacy assets when a native asset.generated trace exists', async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession('sess-dedupe'));
    const ref = {
      id: 'a'.repeat(64),
      mime: 'image/png',
      size: 10,
    };
    await store.addTraceEvent({
      id: 'trace-1',
      sessionId: 'sess-dedupe',
      type: 'asset.generated',
      traceId: 'trace-1',
      turnId: 'turn-1',
      payload: {
        asset: {
          id: 'proposal-1',
          type: 'asset.generate',
          sessionId: 'sess-dedupe',
          turnId: 'turn-1',
          source: { pluginId: 'image-plugin', runtimeId: 'image-plugin' },
          ref,
          modality: 'image',
          createdAt: '2026-04-26T00:00:00.000Z',
        },
      },
      createdAt: '2026-04-26T00:00:00.000Z',
    });
    await store.saveRuntimeResult({
      id: 'rr-1',
      sessionId: 'sess-dedupe',
      turnId: 'turn-1',
      pluginId: 'image-plugin',
      runtimeId: 'image-plugin',
      status: 'success',
      output: { assetGenerations: [{ ref, modality: 'image' }] },
      toolCalls: [],
      durationMs: 1,
      createdAt: '2026-04-26T00:00:01.000Z',
    });

    const app = makeApp(store);
    const res = await app.request('/api/traces/sess-dedupe');
    const body = await res.json() as { events: Array<{ type: string }> };

    expect(body.events.filter((event) => event.type === 'asset.generated')).toHaveLength(1);
  });

  it('marks remote-url legacy assets so they cannot impersonate a content-addressed MediaRef', async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession('sess-remote'));
    await store.setPluginData({
      id: 'pd-remote',
      sessionId: 'sess-remote',
      pluginId: 'image-plugin',
      namespace: 'images',
      key: 'img-1',
      value: {
        turnId: 'turn-1',
        imageUrl: 'https://example.test/legacy.png',
        mime: 'image/png',
      },
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    });

    const app = makeApp(store);
    const res = await app.request('/api/traces/sess-remote');
    const body = await res.json() as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const legacy = body.events.find((event) => event.type === 'asset.generated');
    expect(legacy).toBeDefined();
    expect(legacy?.payload.legacyKind).toBe('remote-url');

    const asset = legacy?.payload.asset as Record<string, unknown>;
    const ref = asset?.ref as { id: string; url?: string };
    // remote-url legacy refs keep the URL so the debug viewer can render
    // the asset directly without going through the media route.
    expect(ref.url).toBe('https://example.test/legacy.png');
    // The id is tagged with the legacy: prefix so any strict consumer
    // immediately knows this is not a real content-addressed ref.
    expect(ref.id.startsWith('legacy:')).toBe(true);
    expect(mediaRefSchema.safeParse(ref).success).toBe(false);
  });
});
