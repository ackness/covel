/**
 * PR-7: end-to-end approval flow tests.
 *
 * Covers:
 *   - community-trust dispatch → 202 approval-required
 *   - GET /api/approvals/:id and the per-session listing
 *   - POST decision → allow once → next dispatch goes through
 *   - decision deny → next dispatch still pending
 *   - session-scope grant → repeated dispatches all auto-allowed
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createMemoryStore, type DataStore } from '@covel/store';
import {
  createPluginRpcRegistry,
  createRpcExecutor,
  type PluginRpcRegistry,
  type RpcExecutor,
} from '@covel/runtime';
import { createRpcApprovalGate, type RpcApprovalGate } from '@covel/approval';
import { pluginRpcRoutes } from '../../src/routes/api/plugin-rpc.js';
import { approvalRoutes, sessionApprovalRoutes } from '../../src/routes/api/approvals.js';

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
  gate: RpcApprovalGate;
} {
  const store = createMemoryStore();
  const registry = createPluginRpcRegistry();
  // Community-trust action that just echoes payload.
  registry.registerPluginAction(
    'untrusted',
    'do-thing',
    { handler: './rpc/do-thing.js', description: 'Run the thing' },
    'community',
  );
  const executor = createRpcExecutor({
    registry,
    loadHandler: async () => async (payload) => ({ ranWith: payload }),
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
  app.route('/api/sessions', sessionApprovalRoutes);
  app.route('/api/approvals', approvalRoutes);
  return { app, store, registry, gate };
}

async function seedSession(store: DataStore, id = 'sess-approval-1'): Promise<void> {
  const now = new Date().toISOString();
  await store.createSession({
    id,
    worldId: 'cloudmere',
    status: 'active',
    turnCount: 1,
    preGameCompleted: [],
    locale: 'zh-CN',
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
}

async function dispatchRpc(app: Hono, sessionId: string): Promise<Response> {
  return app.request(`/api/sessions/${sessionId}/plugin-rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pluginId: 'untrusted',
      action: 'do-thing',
      payload: { foo: 'bar' },
    }),
  });
}

describe('Plugin RPC approval flow (PR-7)', () => {
  let app: Hono;
  let store: DataStore;

  beforeEach(async () => {
    ({ app, store } = setup());
    await seedSession(store);
  });

  it('community-trust dispatch returns 202 with approval-required envelope', async () => {
    const res = await dispatchRpc(app, 'sess-approval-1');
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      approvalId: string;
      pending: { pluginId: string; action: string; description?: string };
    };
    expect(body.status).toBe('approval-required');
    expect(body.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.pending.pluginId).toBe('untrusted');
    expect(body.pending.action).toBe('do-thing');
    expect(body.pending.description).toBe('Run the thing');
  });

  it('GET /api/approvals/:id returns the pending entry', async () => {
    const initial = await dispatchRpc(app, 'sess-approval-1');
    const { approvalId } = (await initial.json()) as { approvalId: string };

    const res = await app.request(`/api/approvals/${approvalId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: { approvalId: string } };
    expect(body.pending.approvalId).toBe(approvalId);
  });

  it('GET /api/sessions/:id/approvals lists session pending entries', async () => {
    await dispatchRpc(app, 'sess-approval-1');
    await dispatchRpc(app, 'sess-approval-1');

    const res = await app.request('/api/sessions/sess-approval-1/approvals');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: ReadonlyArray<unknown> };
    expect(body.pending).toHaveLength(2);
  });

  it('decision allow + scope=once unblocks exactly one follow-up dispatch', async () => {
    const initial = await dispatchRpc(app, 'sess-approval-1');
    const { approvalId } = (await initial.json()) as { approvalId: string };

    // Approve once.
    const decideRes = await app.request(`/api/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', scope: 'once' }),
    });
    expect(decideRes.status).toBe(200);

    // Re-dispatch — should run.
    const second = await dispatchRpc(app, 'sess-approval-1');
    expect(second.status).toBe(200);
    const body = (await second.json()) as { status: string; result: { ranWith: unknown } };
    expect(body.status).toBe('ok');
    expect(body.result.ranWith).toEqual({ foo: 'bar' });

    // A third dispatch should be back to pending — once-grant is consumed.
    const third = await dispatchRpc(app, 'sess-approval-1');
    expect(third.status).toBe(202);
  });

  it('decision allow + scope=session caches for the rest of the session', async () => {
    const initial = await dispatchRpc(app, 'sess-approval-1');
    const { approvalId } = (await initial.json()) as { approvalId: string };

    await app.request(`/api/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', scope: 'session' }),
    });

    // Several follow-ups should all run.
    for (let i = 0; i < 3; i++) {
      const res = await dispatchRpc(app, 'sess-approval-1');
      expect(res.status).toBe(200);
    }
  });

  it('decision deny does not unblock further dispatches', async () => {
    const initial = await dispatchRpc(app, 'sess-approval-1');
    const { approvalId } = (await initial.json()) as { approvalId: string };

    await app.request(`/api/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'deny' }),
    });

    const second = await dispatchRpc(app, 'sess-approval-1');
    expect(second.status).toBe(202); // fresh approvalId, still pending
  });

  it('POST decision with invalid body returns 400', async () => {
    const initial = await dispatchRpc(app, 'sess-approval-1');
    const { approvalId } = (await initial.json()) as { approvalId: string };

    const res = await app.request(`/api/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST decision with unknown approvalId returns 404', async () => {
    const res = await app.request('/api/approvals/nonexistent/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/approvals/:id with unknown id returns 404', async () => {
    const res = await app.request('/api/approvals/nonexistent');
    expect(res.status).toBe(404);
  });
});
