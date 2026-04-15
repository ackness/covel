/**
 * PR-3: POST /api/sessions/:id/plugin-rpc integration tests.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createMemoryStore, type DataStore } from '@covel/store';
import {
  createPluginRpcRegistry,
  createRpcExecutor,
  submitFormHandler,
  type PluginRpcRegistry,
  type RpcExecutor,
} from '@covel/runtime';
import { createRpcApprovalGate, type RpcApprovalGate } from '@covel/approval';
import { pluginRpcRoutes } from '../../src/routes/api/plugin-rpc.js';

type Env = {
  Variables: {
    store: DataStore;
    rpcExecutor: RpcExecutor;
    rpcRegistry: PluginRpcRegistry;
    rpcApprovalGate: RpcApprovalGate;
  };
};

function setup(): {
  app: Hono;
  store: DataStore;
  registry: PluginRpcRegistry;
  executor: RpcExecutor;
  gate: RpcApprovalGate;
} {
  const store = createMemoryStore();
  const registry = createPluginRpcRegistry();
  registry.registerFrameworkDefault('submit-form', submitFormHandler);
  registry.registerFrameworkDefault('echo', async (payload) => ({
    echoed: payload,
  }));
  const executor = createRpcExecutor({
    registry,
    loadHandler: async () => async (payload) => ({ pluginEcho: payload }),
  });
  const gate = createRpcApprovalGate();
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('store', store);
    c.set('rpcExecutor', executor);
    c.set('rpcRegistry', registry);
    c.set('rpcApprovalGate', gate);
    await next();
  });
  app.route('/api/sessions', pluginRpcRoutes);
  return { app, store, registry, executor, gate };
}

async function seedSession(store: DataStore, id = 'sess-rpc-1'): Promise<void> {
  const now = new Date().toISOString();
  await store.createSession({
    id,
    worldId: 'cloudmere',
    phase: 'playing',
    turnCount: 0,
    locale: 'zh-CN',
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
}

describe('POST /api/sessions/:id/plugin-rpc (PR-3)', () => {
  let app: Hono;
  let store: DataStore;
  let registry: PluginRpcRegistry;
  let gate: RpcApprovalGate;

  beforeEach(async () => {
    ({ app, store, registry, gate } = setup());
    await seedSession(store);
  });

  it('returns 404 for unknown session', async () => {
    const res = await app.request('/api/sessions/missing/plugin-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'framework', action: 'echo', payload: {} }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when neither action nor runtimeId is set', async () => {
    const res = await app.request('/api/sessions/sess-rpc-1/plugin-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'framework' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when both action and runtimeId are set', async () => {
    const res = await app.request('/api/sessions/sess-rpc-1/plugin-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pluginId: 'framework',
        action: 'echo',
        runtimeId: 'core-narrator',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 501 for runtime-level dispatch (PR-3.b not yet implemented)', async () => {
    const res = await app.request('/api/sessions/sess-rpc-1/plugin-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pluginId: 'core-codex',
        runtimeId: 'core-codex',
        payload: {},
      }),
    });
    expect(res.status).toBe(501);
  });

  it('dispatches a framework default action and returns the result', async () => {
    const res = await app.request('/api/sessions/sess-rpc-1/plugin-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pluginId: 'framework',
        action: 'echo',
        payload: { hello: 'world' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; result: unknown };
    expect(body.status).toBe('ok');
    expect(body.result).toEqual({ echoed: { hello: 'world' } });
  });

  it('dispatches a plugin-declared action via lazy loader', async () => {
    registry.registerPluginAction(
      'core-codex',
      'regenerate',
      { handler: './rpc/regenerate.js' },
      'official',
    );

    const res = await app.request('/api/sessions/sess-rpc-1/plugin-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pluginId: 'core-codex',
        action: 'regenerate',
        payload: { card: 'shrine' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; result: unknown };
    expect(body.status).toBe('ok');
    expect(body.result).toEqual({ pluginEcho: { card: 'shrine' } });
  });

  it('returns 404 with code "unknown-action" when action not registered', async () => {
    const res = await app.request('/api/sessions/sess-rpc-1/plugin-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pluginId: 'nonexistent',
        action: 'whatever',
        payload: null,
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('unknown-action');
  });

  it('forwards submit-form payload to the framework default handler', async () => {
    // Seed a template message so the handler can fill it.
    await store.appendTurnMessage({
      id: 'msg-template',
      sessionId: 'sess-rpc-1',
      turnId: 'turn-1',
      sourceType: 'runtime',
      sourcePluginId: 'core-char-creator',
      role: 'assistant',
      name: 'form-template',
      content: 'Player name is {{name}}',
      order: 700,
      pendingInput: { formId: 'form-char-creation' },
      createdAt: new Date().toISOString(),
    });

    const res = await app.request('/api/sessions/sess-rpc-1/plugin-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pluginId: 'framework',
        action: 'submit-form',
        payload: {
          turnId: 'turn-1',
          submissions: [
            {
              interactionId: 'form-char-creation',
              type: 'form',
              values: { name: 'Aria' },
            },
          ],
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      result: { accepted: boolean; results: ReadonlyArray<{ filledNarrative: string }> };
    };
    expect(body.status).toBe('ok');
    expect(body.result.accepted).toBe(true);
    expect(body.result.results[0].filledNarrative).toBe('Player name is Aria');
  });

  it('rejects framework actions when pluginId is not the canonical sentinel (LOW-3)', async () => {
    // `echo` is a framework default but the request uses pluginId="core-codex".
    // The canonical sentinel is "framework" — anything else gets 404.
    const res = await app.request('/api/sessions/sess-rpc-1/plugin-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pluginId: 'core-codex',
        action: 'echo',
        payload: {},
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('unknown-action');
  });

  it('returns 400 when submit-form payload is missing turnId', async () => {
    const res = await app.request('/api/sessions/sess-rpc-1/plugin-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pluginId: 'framework',
        action: 'submit-form',
        payload: { submissions: [] },
      }),
    });
    expect(res.status).toBe(400);
  });
});
