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

import { Hono } from "hono";
import type { RpcApprovalGate } from "@covel/approval";
import type { RpcApprovalDecision } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { errorBody } from "../../api-error.js";
import { checkSessionOwnerById } from "./session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
    rpcApprovalGate: RpcApprovalGate;
    /**
     * Lazy activator for community plugins' `tools.local` modules. Wired
     * by bootstrap; absent in narrow test harnesses (use optional chaining).
     */
    activatePluginLocalTools?: (pluginId: string) => Promise<void>;
  };
};

interface DecisionBody {
  readonly decision?: "allow" | "deny";
  readonly scope?: "once" | "session";
}

export const approvalRoutes = new Hono<Env>();
export const sessionApprovalRoutes = new Hono<Env>();

// Per-session listing — mounted under /api/sessions
sessionApprovalRoutes.get("/:id/approvals", async (c) => {
  const gate = c.get("rpcApprovalGate");
  const sessionId = c.req.param("id");
  // Owner guard (audit H-02): pending entries carry plugin RPC payloads for
  // this session. Hosted tiers only; strict no-op on self.
  const denied = await checkSessionOwnerById(c, c.get("store"), sessionId);
  if (denied) return denied;
  return c.json({ pending: gate.listPending(sessionId) });
});

// Revoke cached grants for a session, optionally scoped to one plugin via
// ?pluginId= — withdraws a previously approved community plugin mid-session so
// its next RPC re-prompts for approval. Returns the number of grants cleared.
sessionApprovalRoutes.delete("/:id/approvals", async (c) => {
  const gate = c.get("rpcApprovalGate");
  const sessionId = c.req.param("id");
  // Owner guard (audit H-02): revoking grants mutates another player's
  // approval state. Hosted tiers only; strict no-op on self.
  const denied = await checkSessionOwnerById(c, c.get("store"), sessionId);
  if (denied) return denied;
  const pluginId = c.req.query("pluginId");
  const cleared = gate.revoke(sessionId, pluginId || undefined);
  return c.json({ ok: true, cleared });
});

approvalRoutes.post("/:approvalId/decision", async (c) => {
  const gate = c.get("rpcApprovalGate");
  const approvalId = c.req.param("approvalId");

  // Owner guard (audit H-02): resolve the approvalId to its session FIRST —
  // an attacker who learns an approvalId must not be able to approve
  // community-plugin code for another user's session. The lookup does not
  // consume the pending entry, so a denied caller leaves it intact for the
  // real owner. Unknown ids fall through to `decide()`'s 404 below.
  const pendingForAuth = gate.getPending(approvalId);
  if (pendingForAuth) {
    const denied = await checkSessionOwnerById(
      c,
      c.get("store"),
      pendingForAuth.sessionId,
    );
    if (denied) return denied;
  }

  let body: DecisionBody;
  try {
    body = await c.req.json<DecisionBody>();
  } catch {
    return c.json(errorBody("invalid JSON body"), 400);
  }

  if (body.decision !== "allow" && body.decision !== "deny") {
    return c.json(errorBody('decision must be "allow" or "deny"'), 400);
  }

  if (
    body.decision === "allow" &&
    body.scope &&
    body.scope !== "once" &&
    body.scope !== "session"
  ) {
    return c.json(
      errorBody('scope must be "once" or "session" when allowing'),
      400,
    );
  }

  const decision: RpcApprovalDecision = {
    approvalId,
    decision: body.decision,
    ...(body.decision === "allow" && body.scope ? { scope: body.scope } : {}),
    decidedAt: new Date().toISOString(),
  };

  const result = gate.decide(decision);
  if (!result.ok) {
    return c.json(errorBody(result.error), 404);
  }

  // After an `allow` decision, eagerly activate the plugin's local tools so
  // the renderer's retry of the original RPC doesn't pay the import cost on
  // the hot path. No-op for `deny` decisions and for plugins whose tools
  // are already loaded. Idempotent.
  if (decision.decision === "allow") {
    try {
      await c.get("activatePluginLocalTools")?.(result.pending.pluginId);
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
    scope: decision.scope ?? "once",
    pending: result.pending,
  });
});
