/**
 * PR-3: Plugin RPC route.
 *
 * Single channel for all structured plugin commands:
 *
 *   POST /api/sessions/:id/plugin-rpc[?mode=sync]
 *   {
 *     "pluginId": "core-codex",
 *     "action": "regenerate",     // OR runtimeId, never both
 *     "payload": { ... }
 *   }
 *
 * Default mode is `sync` (single JSON response). Streaming SSE is reserved
 * for a follow-up — handlers can already declare `streaming: true` in their
 * manifest, but the v1 route only delivers the final result.
 *
 * Resolution order:
 *   1. Plugin-declared action (manifest.rpc[action])
 *   2. Framework default (registry.getFrameworkDefault)
 *
 * Runtime-level dispatch (`runtimeId` set) is currently a thin manual-trigger
 * stub — it returns 501 until PR-3.b lands. Action-level covers the
 * submit-form alias path which is the immediate need.
 */

import { Hono } from 'hono';
import type { DataStore } from '@covel/store';
import type { RpcExecutor, PluginRpcRegistry } from '@covel/runtime';
import { RpcDispatchError, RpcValidationError } from '@covel/runtime';
import type { RpcApprovalGate } from '@covel/approval';

type Env = {
  Variables: {
    store: DataStore;
    rpcExecutor: RpcExecutor;
    rpcRegistry: PluginRpcRegistry;
    rpcApprovalGate: RpcApprovalGate;
  };
};

interface PluginRpcBody {
  readonly pluginId?: string;
  readonly action?: string;
  readonly runtimeId?: string;
  readonly payload?: unknown;
}

export const pluginRpcRoutes = new Hono<Env>();

pluginRpcRoutes.post('/:id/plugin-rpc', async (c) => {
  const store = c.get('store');
  const executor = c.get('rpcExecutor');
  const sessionId = c.req.param('id');

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ status: 'error', error: `Session "${sessionId}" not found` }, 404);
  }

  let body: PluginRpcBody;
  try {
    body = await c.req.json<PluginRpcBody>();
  } catch {
    return c.json({ status: 'error', error: 'invalid JSON body' }, 400);
  }

  if (!body.pluginId || typeof body.pluginId !== 'string') {
    return c.json({ status: 'error', error: 'pluginId (string) is required' }, 400);
  }

  if (body.action && body.runtimeId) {
    return c.json(
      { status: 'error', error: 'action and runtimeId are mutually exclusive' },
      400,
    );
  }

  if (!body.action && !body.runtimeId) {
    return c.json(
      { status: 'error', error: 'either action or runtimeId is required' },
      400,
    );
  }

  // Runtime-level manual trigger — defer until follow-up PR.
  if (body.runtimeId) {
    return c.json(
      {
        status: 'error',
        error: 'runtime-level plugin-rpc not yet implemented (PR-3.b)',
      },
      501,
    );
  }

  // PR-7: approval gate. Look up the resolved entry first so we know its
  // trust level, then ask the gate whether the call can proceed. Builtin
  // and official trust auto-allow; community trust either re-uses a cached
  // session approval or returns approval-required for the dialog flow.
  //
  // We deliberately resolve the entry BEFORE invoking the gate so that
  // unknown actions surface as a 404 instead of getting parked in the
  // approval queue forever.
  //
  // LOW-3: framework default actions are namespace-less but still need a
  // canonical sentinel for the request shape. The dispatcher requires
  // `pluginId === "framework"` for framework defaults. Plugin-declared
  // actions still use the real plugin ID.
  const FRAMEWORK_PLUGIN_SENTINEL = 'framework';
  const registry = c.get('rpcRegistry');
  const gate = c.get('rpcApprovalGate');
  let entryTrust: 'builtin' | 'official' | 'community' = 'community';
  let entryDescription: string | undefined;
  const pluginEntry =
    body.pluginId === FRAMEWORK_PLUGIN_SENTINEL
      ? undefined
      : registry.getPluginAction(body.pluginId, body.action!);
  if (pluginEntry) {
    entryTrust = pluginEntry.trustLevel;
    entryDescription = pluginEntry.description;
  } else if (body.pluginId === FRAMEWORK_PLUGIN_SENTINEL) {
    const fwEntry = registry.getFrameworkDefault(body.action!);
    if (fwEntry) {
      entryTrust = fwEntry.trustLevel; // always 'builtin'
      entryDescription = fwEntry.description;
    } else {
      return c.json(
        {
          status: 'error',
          error: `unknown framework action "${body.action}"`,
          code: 'unknown-action',
        },
        404,
      );
    }
  } else {
    return c.json(
      {
        status: 'error',
        error: `unknown action "${body.action}" for plugin "${body.pluginId}"`,
        code: 'unknown-action',
      },
      404,
    );
  }

  const verdict = gate.evaluate({
    sessionId,
    pluginId: body.pluginId,
    action: body.action!,
    payload: body.payload,
    trustLevel: entryTrust,
    description: entryDescription,
  });

  if (verdict.status === 'pending') {
    return c.json(
      {
        status: 'approval-required',
        approvalId: verdict.approvalId,
        pending: verdict.pending,
      },
      202,
    );
  }

  if (verdict.status === 'rejected') {
    // MEDIUM-1: pending queue is full. Map to 429 so clients back off.
    return c.json(
      {
        status: 'error',
        error: `approval queue is full (limit ${verdict.limit}); try again after resolving pending approvals`,
        code: 'queue-full',
      },
      429,
    );
  }

  // Action-level dispatch.
  try {
    const dispatch = await executor.dispatch(
      {
        pluginId: body.pluginId,
        action: body.action!,
        payload: body.payload,
      },
      { sessionId, store },
    );
    return c.json({ status: 'ok', result: dispatch.result });
  } catch (err) {
    if (err instanceof RpcValidationError) {
      return c.json({ status: 'error', error: err.message }, 400);
    }
    if (err instanceof RpcDispatchError) {
      const code = err.code === 'unknown-action' ? 404 : 500;
      return c.json({ status: 'error', error: err.message, code: err.code }, code);
    }
    return c.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : 'plugin-rpc dispatch failed',
      },
      500,
    );
  }
});
