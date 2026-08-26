/**
 * Plugin RPC approval gate.
 *
 * Sits in front of `POST /api/sessions/:id/plugin-rpc`. For every incoming
 * action-level dispatch the route asks the gate `evaluate({ pluginId,
 * action, trustLevel, ... })`. The gate either:
 *
 *   - **allows** the call to proceed (builtin, or session-cached
 *     approval, or one-time approval that was issued moments ago)
 *   - **demands** explicit player approval — returns
 *     `{ status: 'approval-required', approvalId }`. The caller (HTTP layer)
 *     persists the pending request and returns 202 with that envelope so the
 *     frontend can surface a dialog and POST a decision back.
 *
 * The gate is intentionally in-process and ephemeral. Pending approvals do
 * not survive a server restart; session-level pre-authorizations are scoped
 * to both the gate instance and a caller-provided session incarnation. This
 * prevents a stale gate on another process from authorizing a deleted and
 * recreated session that happens to reuse the same public sessionId.
 */

import type {
  RpcApprovalDecision,
  RpcApprovalPending,
  RpcTrustLevel,
} from "@covel/shared";

export interface EvaluateInput {
  readonly sessionId: string;
  /**
   * Stable identifier for this incarnation of the session. Production callers
   * derive it from framework-owned session metadata so grants cannot survive a
   * delete/recreate that reuses the same public sessionId.
   */
  readonly sessionScope: string;
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
    sessionScope: string,
  ):
    | { ok: true; pending: RpcApprovalPending }
    | {
        ok: false;
        error: string;
        reason: "unknown-approval" | "scope-changed";
      };
  /** List all pending approvals for a session. */
  listPending(
    sessionId: string,
    sessionScope: string,
  ): readonly RpcApprovalPending[];
  /** Enumerate every incarnation for local cleanup/compatibility surfaces. */
  listAllPendingForSession(sessionId: string): readonly RpcApprovalPending[];
  /** Test whether one pending request belongs to the supplied incarnation. */
  pendingMatchesScope(approvalId: string, sessionScope: string): boolean;
  /**
   * Look up a pending approval without consuming it. Lets the HTTP layer
   * resolve an approvalId to its sessionId for owner-guard checks BEFORE
   * `decide()` consumes the entry.
   */
  getPending(approvalId: string): RpcApprovalPending | undefined;
  /**
   * Check whether a community plugin currently holds an explicit grant for
   * EXACTLY this action in a session, without consuming a one-time grant or
   * creating a pending request. The action is mandatory — the old optional
   * form matched ANY live grant by prefix, which collapsed the two-phase
   * community approval into "any grant unlocks everything" (2026-07-20
   * audit).
   */
  hasGrant(
    sessionId: string,
    pluginId: string,
    action: string,
    sessionScope: string,
  ): boolean;
  /**
   * Revoke cached session grants + fresh one-time grants for a session,
   * optionally scoped to one plugin. Returns the number of grants cleared.
   * Withdraws a previously approved community plugin mid-session.
   */
  revoke(sessionId: string, pluginId?: string): number;
}

interface InternalState {
  readonly pending: Map<string, ScopedPending>;
  readonly sessionCache: Map<string, ScopedGrant>;
  readonly oneTimeGrants: Map<
    string,
    {
      readonly grant: ScopedGrant;
      readonly issuedAt: number;
      /** Payload the player actually approved for this single dispatch. */
      readonly payload: unknown;
    }
  >;
}

interface ScopedGrant {
  readonly sessionId: string;
  readonly sessionScope: string;
  readonly pluginId: string;
  readonly action: string;
}

interface ScopedPending {
  readonly sessionScope: string;
  readonly record: RpcApprovalPending;
}

const ONE_TIME_GRANT_TTL_MS = 60_000;

/**
 * Generic approval action used before importing community server code.
 * Uses the reserved `covel:` framework namespace so a third-party plugin
 * cannot declare a real action with this exact name and thereby satisfy the
 * phase-2 action check from the phase-1 grant, eliding the second
 * confirmation.
 */
export const COMMUNITY_SERVER_CODE_ACTION = "covel:plugin-server-code";

/**
 * Cap the pending-approval queue so a malicious caller cannot
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
  sessionScope: string,
  pluginId: string,
  action: string,
): string {
  return JSON.stringify([sessionId, sessionScope, pluginId, action]);
}

function resolveSessionScope(sessionScope: string): string {
  if (!sessionScope) {
    throw new Error("sessionScope is required for RPC approval decisions");
  }
  return sessionScope;
}

/**
 * Compare JSON-shaped RPC payloads structurally. HTTP JSON object key order is
 * not semantically meaningful, so a stringify comparison would incorrectly
 * reject an honest retry whose keys were serialized in a different order.
 */
function samePayload(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => samePayload(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        samePayload(leftRecord[key], rightRecord[key]),
    )
  );
}

export function createRpcApprovalGate(): RpcApprovalGate {
  const state: InternalState = {
    pending: new Map(),
    sessionCache: new Map(),
    oneTimeGrants: new Map(),
  };

  function isAutoTrusted(level: RpcTrustLevel): boolean {
    return level === "builtin";
  }

  function consumeOneTimeIfFresh(
    sessionId: string,
    pluginId: string,
    action: string,
    sessionScope: string,
    payload: unknown,
  ): boolean {
    const key = tripleKey(sessionId, sessionScope, pluginId, action);
    const entry = state.oneTimeGrants.get(key);
    if (entry === undefined) return false;
    if (Date.now() - entry.issuedAt > ONE_TIME_GRANT_TTL_MS) {
      state.oneTimeGrants.delete(key);
      return false;
    }
    // `once` authorizes the exact dispatch shown in the approval dialog, not
    // an arbitrary later invocation that happens to share the action name.
    if (!samePayload(entry.payload, payload)) return false;
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
      const ts = Date.parse(entry.record.requestedAt);
      if (Number.isFinite(ts) && ts < cutoff) {
        state.pending.delete(id);
      }
    }
  }

  function countSessionPending(
    sessionId: string,
    sessionScope: string,
  ): number {
    let n = 0;
    for (const entry of state.pending.values()) {
      if (
        entry.record.sessionId === sessionId &&
        entry.sessionScope === sessionScope
      ) {
        n++;
      }
    }
    return n;
  }

  return {
    evaluate(input) {
      const sessionScope = resolveSessionScope(input.sessionScope);
      // 1. Builtin → always allowed, no dialog.
      if (isAutoTrusted(input.trustLevel)) {
        return { status: "allow", reason: "trusted" };
      }

      // 2. Session-level pre-authorization → always allowed.
      const key = tripleKey(
        input.sessionId,
        sessionScope,
        input.pluginId,
        input.action,
      );
      if (state.sessionCache.has(key)) {
        return { status: "allow", reason: "session-cached" };
      }

      // 3. One-time grant issued moments ago → consume and allow once.
      if (
        consumeOneTimeIfFresh(
          input.sessionId,
          input.pluginId,
          input.action,
          sessionScope,
          input.payload,
        )
      ) {
        return { status: "allow", reason: "one-time-grant" };
      }

      // 4. Otherwise create a pending approval for the dialog flow. Expire old
      // entries before looking for a reusable request; otherwise a retry of
      // the same action can keep an hour-old payload alive forever.
      sweepStalePending();
      // Reuse an unresolved request for the same capability. This bounds
      // duplicate clicks and lets revoke/disable cancel one stable approval.
      for (const pending of state.pending.values()) {
        if (
          pending.sessionScope === sessionScope &&
          pending.record.sessionId === input.sessionId &&
          pending.record.pluginId === input.pluginId &&
          pending.record.action === input.action &&
          samePayload(pending.record.payload, input.payload)
        ) {
          return {
            status: "pending",
            approvalId: pending.record.approvalId,
            pending: pending.record,
          };
        }
      }
      // Enforce queue caps before allocation. The stale sweep above also keeps
      // a long-lived process from being pinned at the cap by old requests.
      if (state.pending.size >= MAX_PENDING_GLOBAL) {
        return {
          status: "rejected",
          reason: "queue-full",
          limit: MAX_PENDING_GLOBAL,
        };
      }
      if (
        countSessionPending(input.sessionId, sessionScope) >=
        MAX_PENDING_PER_SESSION
      ) {
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
      state.pending.set(approvalId, { sessionScope, record: pending });
      return { status: "pending", approvalId, pending };
    },

    decide(decision, expectedSessionScope) {
      const scopedPending = state.pending.get(decision.approvalId);
      if (!scopedPending) {
        return {
          ok: false,
          error: `unknown approvalId: ${decision.approvalId}`,
          reason: "unknown-approval",
        };
      }

      if (
        scopedPending.sessionScope !== resolveSessionScope(expectedSessionScope)
      ) {
        return {
          ok: false,
          error: `approval scope changed for ${decision.approvalId}`,
          reason: "scope-changed",
        };
      }

      const pending = scopedPending.record;

      // Pending entry consumed regardless of decision.
      state.pending.delete(decision.approvalId);

      if (decision.decision === "deny") {
        return { ok: true, pending };
      }

      // Allow path: cache or one-time grant depending on scope.
      const key = tripleKey(
        pending.sessionId,
        scopedPending.sessionScope,
        pending.pluginId,
        pending.action,
      );
      const grant: ScopedGrant = {
        sessionId: pending.sessionId,
        sessionScope: scopedPending.sessionScope,
        pluginId: pending.pluginId,
        action: pending.action,
      };
      if (decision.scope === "session") {
        state.sessionCache.set(key, grant);
      } else {
        // Default scope is `once` — the next dispatch can use the grant
        // exactly once, then it is consumed. The TTL guards against stale
        // grants from a player that approved 10 minutes ago.
        state.oneTimeGrants.set(key, {
          grant,
          issuedAt: Date.now(),
          payload: pending.payload,
        });
      }

      return { ok: true, pending };
    },

    listPending(sessionId, expectedSessionScope) {
      const resolvedScope = resolveSessionScope(expectedSessionScope);
      return [...state.pending.values()]
        .filter(
          (pending) =>
            pending.record.sessionId === sessionId &&
            pending.sessionScope === resolvedScope,
        )
        .map((pending) => pending.record);
    },

    listAllPendingForSession(sessionId) {
      return [...state.pending.values()]
        .filter((pending) => pending.record.sessionId === sessionId)
        .map((pending) => pending.record);
    },

    getPending(approvalId) {
      return state.pending.get(approvalId)?.record;
    },

    pendingMatchesScope(approvalId, expectedSessionScope) {
      return (
        state.pending.get(approvalId)?.sessionScope ===
        resolveSessionScope(expectedSessionScope)
      );
    },

    hasGrant(sessionId, pluginId, action, expectedSessionScope) {
      const exactKey = tripleKey(
        sessionId,
        resolveSessionScope(expectedSessionScope),
        pluginId,
        action,
      );
      if (state.sessionCache.has(exactKey)) {
        return true;
      }

      const now = Date.now();
      for (const [key, entry] of state.oneTimeGrants) {
        if (now - entry.issuedAt > ONE_TIME_GRANT_TTL_MS) {
          state.oneTimeGrants.delete(key);
          continue;
        }
        if (key === exactKey) return true;
      }
      return false;
    },

    revoke(sessionId, pluginId) {
      let cleared = 0;
      for (const [key, grant] of state.sessionCache) {
        if (
          grant.sessionId === sessionId &&
          (!pluginId || grant.pluginId === pluginId)
        ) {
          state.sessionCache.delete(key);
          cleared += 1;
        }
      }
      for (const [key, entry] of state.oneTimeGrants) {
        if (
          entry.grant.sessionId === sessionId &&
          (!pluginId || entry.grant.pluginId === pluginId)
        ) {
          state.oneTimeGrants.delete(key);
          cleared += 1;
        }
      }
      for (const [approvalId, pending] of state.pending) {
        if (
          pending.record.sessionId === sessionId &&
          (!pluginId || pending.record.pluginId === pluginId)
        ) {
          state.pending.delete(approvalId);
          cleared += 1;
        }
      }
      return cleared;
    },
  };
}
