/**
 * PR-7: Plugin RPC approval routes.
 *
 *   GET  /api/sessions/:id/approvals
 *     List pending approvals for a session (so the frontend can resync
 *     the dialog after a refresh).
 *
 *   GET  /api/approvals/:approvalId
 *     Look up a single pending approval.
 *
 *   POST /api/approvals/:approvalId/decision
 *     Persist a player decision. Body:
 *       { decision: 'allow' | 'deny', scope?: 'once' | 'session' }
 *
 * The dispatch path itself lives in `plugin-rpc.ts` — these routes only
 * mediate the approval lifecycle. Once the player allows a request, the
 * frontend re-issues the original `POST /api/sessions/:id/plugin-rpc`
 * call and the gate honours the cached/grant entry.
 */

import { Hono } from 'hono';
import type { RpcApprovalGate } from '@covel/approval';
import type { RpcApprovalDecision } from '@covel/shared';

type Env = {
  Variables: {
    rpcApprovalGate: RpcApprovalGate;
    /**
     * Lazy activator for community plugins' `tools.local` modules. Wired
     * by bootstrap; absent in narrow test harnesses (use optional chaining).
     */
    activatePluginLocalTools?: (pluginId: string) => Promise<void>;
  };
};

interface DecisionBody {
  readonly decision?: 'allow' | 'deny';
  readonly scope?: 'once' | 'session';
}

export const approvalRoutes = new Hono<Env>();
export const sessionApprovalRoutes = new Hono<Env>();

// Per-session listing — mounted under /api/sessions
sessionApprovalRoutes.get('/:id/approvals', (c) => {
  const gate = c.get('rpcApprovalGate');
  const sessionId = c.req.param('id');
  return c.json({ pending: gate.listPending(sessionId) });
});

approvalRoutes.post('/:approvalId/decision', async (c) => {
  const gate = c.get('rpcApprovalGate');
  const approvalId = c.req.param('approvalId');

  let body: DecisionBody;
  try {
    body = await c.req.json<DecisionBody>();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  if (body.decision !== 'allow' && body.decision !== 'deny') {
    return c.json({ error: 'decision must be "allow" or "deny"' }, 400);
  }

  if (body.decision === 'allow' && body.scope && body.scope !== 'once' && body.scope !== 'session') {
    return c.json({ error: 'scope must be "once" or "session" when allowing' }, 400);
  }

  const decision: RpcApprovalDecision = {
    approvalId,
    decision: body.decision,
    ...(body.decision === 'allow' && body.scope ? { scope: body.scope } : {}),
    decidedAt: new Date().toISOString(),
  };

  const result = gate.decide(decision);
  if (!result.ok) {
    return c.json({ error: result.error }, 404);
  }

  // After an `allow` decision, eagerly activate the plugin's local tools so
  // the renderer's retry of the original RPC doesn't pay the import cost on
  // the hot path. No-op for `deny` decisions and for plugins whose tools
  // are already loaded. Idempotent.
  if (decision.decision === 'allow') {
    try {
      await c.get('activatePluginLocalTools')?.(result.pending.pluginId);
    } catch (err) {
      // Activation failure is logged but does not roll back the approval —
      // the user's decision stands, and the next plugin-rpc call will retry
      // activation just-in-time.
      console.warn(
        `[approvals] tools.local activation failed for ${result.pending.pluginId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return c.json({
    ok: true,
    decision: decision.decision,
    scope: decision.scope ?? 'once',
    pending: result.pending,
  });
});
