/**
 * Plugin RPC approval routes.
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
import {
  COMMUNITY_SERVER_CODE_ACTION,
  type RpcApprovalGate,
} from "@covel/approval";
import type { RpcApprovalDecision } from "@covel/shared";
import type { DataStore } from "@covel/store";
import type { SessionLock } from "../../lib/session-lock.js";
import { errorBody } from "../../api-error.js";
import {
  checkSessionOwner,
  checkHostedOperator,
  checkSessionOwnerById,
  rotateSessionApprovalScope,
  sessionApprovalScope,
  withLockedSessionMutation,
} from "./session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
    sessionLock: SessionLock;
    rpcApprovalGate: RpcApprovalGate;
    /**
     * Lazy activator for community plugins' `tools.local` modules. Wired
     * by bootstrap; absent in narrow test harnesses (use optional chaining).
     */
    activatePluginServerCode?: (
      pluginId: string,
      sessionId?: string,
    ) => Promise<void>;
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
  // Preserve the local/self-tier compatibility behavior for callers that
  // list before the transient server-side session row has been synced. Hosted
  // tiers still require a live owned session through this guard.
  const store = c.get("store");
  const denied = await checkSessionOwnerById(c, store, sessionId);
  if (denied) return denied;
  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ pending: gate.listAllPendingForSession(sessionId) });
  }
  const current = gate
    .listAllPendingForSession(sessionId)
    .filter((pending) =>
      gate.pendingMatchesScope(
        pending.approvalId,
        sessionApprovalScope(session, pending.pluginId),
      ),
    );
  return c.json({ pending: current });
});

// Revoke cached grants for a session, optionally scoped to one plugin via
// ?pluginId= — withdraws a previously approved community plugin mid-session so
// its next RPC re-prompts for approval. Returns the number of grants cleared.
sessionApprovalRoutes.delete("/:id/approvals", async (c) => {
  const gate = c.get("rpcApprovalGate");
  const sessionId = c.req.param("id");
  const pluginId = c.req.query("pluginId");
  const store = c.get("store");
  const denied = await checkSessionOwnerById(c, store, sessionId);
  if (denied) return denied;
  const session = await store.getSession(sessionId);
  if (!session) {
    const cleared = gate.revoke(sessionId, pluginId || undefined);
    return c.json({ ok: true, cleared });
  }
  return withLockedSessionMutation({
    c,
    store,
    sessionLock: c.get("sessionLock"),
    sessionId,
    expectedSession: session,
    allowedStatuses: "any",
    mutate: async (liveSession) => {
      await store.updateSession(sessionId, {
        metadata: rotateSessionApprovalScope(
          liveSession,
          pluginId || undefined,
        ),
        updatedAt: new Date().toISOString(),
      });
      const cleared = gate.revoke(sessionId, pluginId || undefined);
      return c.json({ ok: true, cleared });
    },
  });
});

approvalRoutes.post("/:approvalId/decision", async (c) => {
  const gate = c.get("rpcApprovalGate");
  const approvalId = c.req.param("approvalId");

  // Owner guard: resolve the approvalId to its session FIRST —
  // an attacker who learns an approvalId must not be able to approve
  // community-plugin code for another user's session. The lookup does not
  // consume the pending entry, so a denied caller leaves it intact for the
  // real owner. Unknown ids fall through to `decide()`'s 404 below.
  const pendingForAuth = gate.getPending(approvalId);
  if (!pendingForAuth) {
    return c.json(
      errorBody(`unknown approvalId: ${approvalId}`, {
        code: "approval_not_found",
      }),
      404,
    );
  }
  const session = await c.get("store").getSession(pendingForAuth.sessionId);
  if (!session) {
    return c.json(
      errorBody(`Session not found: ${pendingForAuth.sessionId}`, {
        code: "session_not_found",
      }),
      404,
    );
  }
  const denied = checkSessionOwner(c, session);
  if (denied) return denied;
  if (pendingForAuth.trustLevel === "community") {
    const operatorDenied = checkHostedOperator(c);
    if (operatorDenied) return operatorDenied;
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

  // Runtime and plugin-enable approvals unlock server modules, hooks and
  // tool registrations that outlive a single HTTP dispatch. Their safe
  // meaning is therefore session-scoped; action-level RPC approvals retain
  // the existing once/session choice.
  if (
    body.decision === "allow" &&
    (pendingForAuth.action === COMMUNITY_SERVER_CODE_ACTION ||
      pendingForAuth.action.startsWith("runtime:")) &&
    body.scope !== "session"
  ) {
    return c.json(
      errorBody(
        "runtime and plugin server-code approvals require session scope",
      ),
      400,
    );
  }

  const decision: RpcApprovalDecision = {
    approvalId,
    decision: body.decision,
    ...(body.decision === "allow" && body.scope ? { scope: body.scope } : {}),
    decidedAt: new Date().toISOString(),
  };

  const accepted = await withLockedSessionMutation({
    c,
    store: c.get("store"),
    sessionLock: c.get("sessionLock"),
    sessionId: pendingForAuth.sessionId,
    expectedSession: session,
    allowedStatuses: "any",
    mutate: async (liveSession) => {
      // Re-resolve both the pending entry and persisted incarnation under the
      // same cross-Pod lock used by revoke/delete. The lock protects only the
      // approval state transition; plugin entry code runs after it is released.
      const livePending = gate.getPending(approvalId);
      if (!livePending) {
        return c.json(
          errorBody(`unknown approvalId: ${approvalId}`, {
            code: "approval_not_found",
          }),
          404,
        );
      }
      if (livePending.sessionId !== pendingForAuth.sessionId) {
        return c.json(
          errorBody("Approval session changed while deciding", {
            code: "approval_scope_changed",
          }),
          409,
        );
      }

      const result = gate.decide(
        decision,
        sessionApprovalScope(liveSession, livePending.pluginId),
      );
      if (!result.ok) {
        return c.json(
          errorBody(result.error, {
            code:
              result.reason === "scope-changed"
                ? "approval_scope_changed"
                : "approval_not_found",
          }),
          result.reason === "scope-changed" ? 409 : 404,
        );
      }
      return result.pending;
    },
  });
  if (accepted instanceof Response) return accepted;

  // Community entry code is arbitrary and may call back into a same-session
  // HTTP endpoint. Never await it while holding the non-reentrant HTTP
  // lifecycle lock. The activator rechecks the live approval scope and fails
  // closed if revoke/delete won the race after `decide`.
  if (decision.decision === "allow") {
    try {
      await c.get("activatePluginServerCode")?.(
        accepted.pluginId,
        accepted.sessionId,
      );
    } catch (err) {
      // Activation failure does not roll back the user's approval; the next
      // plugin-rpc call retries activation against the live scope.
      console.warn(
        `[approvals] tools.local activation failed for ${accepted.pluginId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return c.json({
    ok: true,
    decision: decision.decision,
    scope: decision.scope ?? "once",
    pending: accepted,
  });
});
