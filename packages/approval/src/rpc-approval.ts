/**
 * PR-7: Plugin RPC approval gate.
 *
 * Sits in front of `POST /api/sessions/:id/plugin-rpc`. For every incoming
 * action-level dispatch the route asks the gate `evaluate({ pluginId,
 * action, trustLevel, ... })`. The gate either:
 *
 *   - **allows** the call to proceed (builtin/official, or session-cached
 *     approval, or one-time approval that was issued moments ago)
 *   - **demands** explicit player approval — returns
 *     `{ status: 'approval-required', approvalId }`. The caller (HTTP layer)
 *     persists the pending request and returns 202 with that envelope so the
 *     frontend can surface a dialog and POST a decision back.
 *
 * The gate is intentionally in-process and ephemeral. Pending approvals do
 * not survive a server restart; session-level pre-authorizations are
 * scoped to the gate instance. A future enhancement can persist them to
 * `plugin_data` if cross-restart resilience matters.
 */

import type {
  RpcApprovalDecision,
  RpcApprovalPending,
  RpcTrustLevel,
} from "@covel/shared";

export interface EvaluateInput {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly action: string;
  readonly payload: unknown;
  readonly trustLevel: RpcTrustLevel;
  /** One-line description shown to the player in the approval dialog. */
  readonly description?: string;
}

export type EvaluateResult =
  | {
      readonly status: "allow";
      readonly reason: "trusted" | "session-cached" | "one-time-grant";
    }
  | {
      readonly status: "pending";
      readonly approvalId: string;
      readonly pending: RpcApprovalPending;
    }
  | {
      readonly status: "rejected";
      readonly reason: "queue-full";
      readonly limit: number;
    };

export interface RpcApprovalGate {
  /** Inspect a request and decide whether it can run, needs approval, or was already authorized. */
  evaluate(input: EvaluateInput): EvaluateResult;
  /** Record a player decision against a previously issued approvalId. */
  decide(
    decision: RpcApprovalDecision,
  ): { ok: true; pending: RpcApprovalPending } | { ok: false; error: string };
  /** List all pending approvals for a session. */
  listPending(sessionId: string): readonly RpcApprovalPending[];
  /**
   * Look up a pending approval without consuming it. Lets the HTTP layer
   * resolve an approvalId to its sessionId for owner-guard checks BEFORE
   * `decide()` consumes the entry (audit H-02).
   */
  getPending(approvalId: string): RpcApprovalPending | undefined;
  /**
   * Check whether a community plugin currently has an explicit grant in a
   * session without consuming a one-time grant or creating a pending request.
   * Omitting `action` checks for any live grant belonging to the plugin.
   */
  hasGrant(sessionId: string, pluginId: string, action?: string): boolean;
  /**
   * Revoke cached session grants + fresh one-time grants for a session,
   * optionally scoped to one plugin. Returns the number of grants cleared.
   * Withdraws a previously approved community plugin mid-session.
   */
  revoke(sessionId: string, pluginId?: string): number;
}

interface InternalState {
  readonly pending: Map<string, RpcApprovalPending>;
  /** Key = `${sessionId}::${pluginId}::${action}` */
  readonly sessionCache: Set<string>;
  /** Key = same shape as sessionCache, value = creation timestamp ms. */
  readonly oneTimeGrants: Map<string, number>;
}

const ONE_TIME_GRANT_TTL_MS = 60_000;

/** Generic approval action used before importing community server code. */
export const COMMUNITY_SERVER_CODE_ACTION = "plugin:server-code";

/**
 * MEDIUM-1 fix: cap the pending-approval queue so a malicious caller cannot
 * leak memory by spamming community-trust dispatches.
 *
 *   - `MAX_PENDING_PER_SESSION`: hard cap per (sessionId). Once reached the
 *     gate returns `rejected` so the route can map it to a 429 status.
 *   - `MAX_PENDING_GLOBAL`: process-wide ceiling as a safety net against
 *     many sessions hitting their per-session cap simultaneously.
 *   - `STALE_PENDING_TTL_MS`: pending entries older than this are sweepable
 *     when the gate notices them during a write — keeps a long-lived
 *     unanswered queue from pinning memory after a runaway plugin.
 */
const MAX_PENDING_PER_SESSION = 64;
const MAX_PENDING_GLOBAL = 1024;
const STALE_PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

function tripleKey(
  sessionId: string,
  pluginId: string,
  action: string,
): string {
  return `${sessionId}::${pluginId}::${action}`;
}

export function createRpcApprovalGate(): RpcApprovalGate {
  const state: InternalState = {
    pending: new Map(),
    sessionCache: new Set(),
    oneTimeGrants: new Map(),
  };

  function isAutoTrusted(level: RpcTrustLevel): boolean {
    return level === "builtin" || level === "official";
  }

  function consumeOneTimeIfFresh(
    sessionId: string,
    pluginId: string,
    action: string,
  ): boolean {
    const key = tripleKey(sessionId, pluginId, action);
    const issued = state.oneTimeGrants.get(key);
    if (issued === undefined) return false;
    if (Date.now() - issued > ONE_TIME_GRANT_TTL_MS) {
      state.oneTimeGrants.delete(key);
      return false;
    }
    state.oneTimeGrants.delete(key);
    return true;
  }

  /**
   * Sweep stale pending entries (older than STALE_PENDING_TTL_MS). Called
   * opportunistically before each new evaluation so the caller doing the
   * work pays for its own cleanup, no background timer needed.
   */
  function sweepStalePending(): void {
    const cutoff = Date.now() - STALE_PENDING_TTL_MS;
    for (const [id, entry] of state.pending) {
      const ts = Date.parse(entry.requestedAt);
      if (Number.isFinite(ts) && ts < cutoff) {
        state.pending.delete(id);
      }
    }
  }

  function countSessionPending(sessionId: string): number {
    let n = 0;
    for (const entry of state.pending.values()) {
      if (entry.sessionId === sessionId) n++;
    }
    return n;
  }

  return {
    evaluate(input) {
      // 1. Builtin/official → always allowed, no dialog.
      if (isAutoTrusted(input.trustLevel)) {
        return { status: "allow", reason: "trusted" };
      }

      // 2. Session-level pre-authorization → always allowed.
      const key = tripleKey(input.sessionId, input.pluginId, input.action);
      if (state.sessionCache.has(key)) {
        return { status: "allow", reason: "session-cached" };
      }

      // 3. One-time grant issued moments ago → consume and allow once.
      if (
        consumeOneTimeIfFresh(input.sessionId, input.pluginId, input.action)
      ) {
        return { status: "allow", reason: "one-time-grant" };
      }

      // 4. Otherwise create a pending approval for the dialog flow.
      // Reuse an unresolved request for the same capability. This bounds
      // duplicate clicks and lets revoke/disable cancel one stable approval.
      for (const pending of state.pending.values()) {
        if (
          pending.sessionId === input.sessionId &&
          pending.pluginId === input.pluginId &&
          pending.action === input.action
        ) {
          return {
            status: "pending",
            approvalId: pending.approvalId,
            pending,
          };
        }
      }
      // MEDIUM-1: enforce queue caps before allocation. Sweep stale entries
      // first so a long-lived process doesn't get pinned at the cap by
      // ancient unanswered pendings.
      sweepStalePending();
      if (state.pending.size >= MAX_PENDING_GLOBAL) {
        return {
          status: "rejected",
          reason: "queue-full",
          limit: MAX_PENDING_GLOBAL,
        };
      }
      if (countSessionPending(input.sessionId) >= MAX_PENDING_PER_SESSION) {
        return {
          status: "rejected",
          reason: "queue-full",
          limit: MAX_PENDING_PER_SESSION,
        };
      }

      const approvalId = crypto.randomUUID();
      const pending: RpcApprovalPending = {
        approvalId,
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        action: input.action,
        payload: input.payload,
        trustLevel: input.trustLevel,
        requestedAt: new Date().toISOString(),
        ...(input.description ? { description: input.description } : {}),
      };
      state.pending.set(approvalId, pending);
      return { status: "pending", approvalId, pending };
    },

    decide(decision) {
      const pending = state.pending.get(decision.approvalId);
      if (!pending) {
        return {
          ok: false,
          error: `unknown approvalId: ${decision.approvalId}`,
        };
      }

      // Pending entry consumed regardless of decision.
      state.pending.delete(decision.approvalId);

      if (decision.decision === "deny") {
        return { ok: true, pending };
      }

      // Allow path: cache or one-time grant depending on scope.
      const key = tripleKey(
        pending.sessionId,
        pending.pluginId,
        pending.action,
      );
      if (decision.scope === "session") {
        state.sessionCache.add(key);
      } else {
        // Default scope is `once` — the next dispatch can use the grant
        // exactly once, then it is consumed. The TTL guards against stale
        // grants from a player that approved 10 minutes ago.
        state.oneTimeGrants.set(key, Date.now());
      }

      return { ok: true, pending };
    },

    listPending(sessionId) {
      return [...state.pending.values()].filter(
        (p) => p.sessionId === sessionId,
      );
    },

    getPending(approvalId) {
      return state.pending.get(approvalId);
    },

    hasGrant(sessionId, pluginId, action) {
      const prefix = `${sessionId}::${pluginId}::`;
      const exactKey = action
        ? tripleKey(sessionId, pluginId, action)
        : undefined;
      if (
        exactKey
          ? state.sessionCache.has(exactKey)
          : [...state.sessionCache].some((key) => key.startsWith(prefix))
      ) {
        return true;
      }

      const now = Date.now();
      for (const [key, issued] of state.oneTimeGrants) {
        if (now - issued > ONE_TIME_GRANT_TTL_MS) {
          state.oneTimeGrants.delete(key);
          continue;
        }
        if (exactKey ? key === exactKey : key.startsWith(prefix)) return true;
      }
      return false;
    },

    revoke(sessionId, pluginId) {
      // Keys are `${sessionId}::${pluginId}::${action}`; the `::` delimiter and
      // the enumeration-resistant session id make this prefix match exact.
      const prefix = pluginId
        ? `${sessionId}::${pluginId}::`
        : `${sessionId}::`;
      let cleared = 0;
      for (const key of [...state.sessionCache]) {
        if (key.startsWith(prefix)) {
          state.sessionCache.delete(key);
          cleared += 1;
        }
      }
      for (const key of [...state.oneTimeGrants.keys()]) {
        if (key.startsWith(prefix)) {
          state.oneTimeGrants.delete(key);
          cleared += 1;
        }
      }
      for (const [approvalId, pending] of state.pending) {
        if (
          pending.sessionId === sessionId &&
          (!pluginId || pending.pluginId === pluginId)
        ) {
          state.pending.delete(approvalId);
          cleared += 1;
        }
      }
      return cleared;
    },
  };
}
