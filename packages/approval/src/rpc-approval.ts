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
      readonly reason:
        | "trusted"
        | "trusted-source"
        | "persistent-grant"
        | "session-cached"
        | "one-time-grant";
    }
  | {
      readonly status: "denied";
      readonly reason: "ceiling" | "policy" | "grant";
      readonly capability?: string;
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
  /** Enumerate every incarnation for local cleanup. */
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
   * Check whether a community plugin currently holds an explicit or implicit grant for
   * EXACTLY this action in a session, without consuming a one-time grant or
   * creating a pending request. The action is mandatory — the old optional
   * form matched ANY live grant by prefix, which collapsed the two-phase
   * community approval into "any grant unlocks everything" (2026-07-20
   * audit).
   *
   * When a `payload` argument is provided, one-time grants only match an
   * unexpired grant for that exact payload (structural JSON equality);
   * implicit and session-scoped grants remain action-level.
   */
  hasGrant(
    sessionId: string,
    pluginId: string,
    action: string,
    sessionScope: string,
    ...payloadArg: [] | [payload: unknown]
  ): boolean;
  /**
   * Revoke cached session grants + fresh one-time grants for a session,
   * optionally scoped to one plugin. Returns the number of grants cleared.
   * Clears explicit consent mid-session; instance implicit policy is unchanged.
   */
  revoke(sessionId: string, pluginId?: string): number;
  /**
   * List active session-scoped L4 grants matching current session incarnation
   * scopes, ordered by `(pluginId, action)`.
   */
  listSessionGrants(
    sessionId: string,
    scopeForPlugin: (pluginId: string) => string,
  ): readonly { readonly pluginId: string; readonly action: string }[];
  /**
   * Revoke all cached session grants, one-time grants, and pending approvals
   * for `pluginId` across every session.
   */
  revokePlugin(pluginId: string): number;
}

interface OneTimeGrantEntry {
  readonly grant: ScopedGrant;
  readonly issuedAt: number;
  /** Payload the player actually approved for this single dispatch. */
  readonly payload: unknown;
}

interface InternalState {
  readonly pending: Map<string, ScopedPending>;
  readonly sessionCache: Map<string, ScopedGrant>;
  readonly oneTimeGrants: Map<string, OneTimeGrantEntry[]>;
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

export const ONE_TIME_GRANT_TTL_MS = 60_000;
export const MAX_SESSION_CACHE = 4096;
export const IMPLICIT_ERROR_WARN_INTERVAL_MS = 60_000;

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
 *   - `STALE_PENDING_TTL_MS`: pending entries older than this are swept when
 *     reading or mutating pending state — keeps a long-lived unanswered queue
 *     from pinning memory or letting expired prompts be approved later.
 */
const MAX_PENDING_PER_SESSION = 64;
const MAX_PENDING_GLOBAL = 1024;
export const STALE_PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ONE_TIME_GRANTS_PER_KEY = MAX_PENDING_PER_SESSION;
const MAX_ONE_TIME_GRANTS_GLOBAL = MAX_PENDING_GLOBAL;

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

export interface ImplicitGrantQuery {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly action: string;
}

export type PolicyDecisionResult =
  | {
      readonly decision: "allow";
      readonly reason: "trusted-source" | "persistent-grant";
    }
  | {
      readonly decision: "deny";
      readonly reason: "ceiling" | "policy" | "grant";
      readonly capability?: string;
    }
  | { readonly decision: "ask" };

export interface RpcApprovalGateOptions {
  readonly implicitGrant?: (query: ImplicitGrantQuery) => boolean;
  /** Unified L1–L3 policy pre-check evaluated ahead of L4 session grants. */
  readonly policyDecision?: (query: ImplicitGrantQuery) => PolicyDecisionResult;
  /** Maximum number of session-scoped grants retained in LRU order. */
  readonly maxSessionCache?: number;
}
export function createRpcApprovalGate(
  options: RpcApprovalGateOptions = {},
): RpcApprovalGate {
  const maxSessionCache = options.maxSessionCache ?? MAX_SESSION_CACHE;
  if (!Number.isSafeInteger(maxSessionCache) || maxSessionCache < 1) {
    throw new RangeError("maxSessionCache must be a positive integer");
  }

  let lastImplicitErrorWarnMs: number | undefined;
  let suppressedImplicitErrors = 0;
  function warnPolicyFailure(label: string, error: unknown): void {
    const now = Date.now();
    if (
      lastImplicitErrorWarnMs === undefined ||
      now - lastImplicitErrorWarnMs >= IMPLICIT_ERROR_WARN_INTERVAL_MS
    ) {
      const suppressedNote =
        suppressedImplicitErrors > 0
          ? ` (${suppressedImplicitErrors} suppressed since last warning)`
          : "";
      console.warn(`[rpc-approval] ${label}${suppressedNote}:`, error);
      lastImplicitErrorWarnMs = now;
      suppressedImplicitErrors = 0;
    } else {
      suppressedImplicitErrors += 1;
    }
  }

  function evaluatePolicy(query: ImplicitGrantQuery): PolicyDecisionResult {
    if (!options.policyDecision) return { decision: "ask" };
    try {
      return options.policyDecision(query);
    } catch (error) {
      warnPolicyFailure("policy evaluation failed", error);
      return { decision: "ask" };
    }
  }

  function implicitlyGranted(query: ImplicitGrantQuery): boolean {
    if (
      query.action !== COMMUNITY_SERVER_CODE_ACTION &&
      !query.action.startsWith("runtime:")
    )
      return false;
    try {
      return options.implicitGrant?.(query) === true;
    } catch (error) {
      warnPolicyFailure("implicit grant failed", error);
      return false;
    }
  }
  const state: InternalState = {
    pending: new Map(),
    sessionCache: new Map(),
    oneTimeGrants: new Map(),
  };

  function isAutoTrusted(level: RpcTrustLevel): boolean {
    return level === "builtin";
  }

  function hasSessionCacheGrant(key: string): boolean {
    const grant = state.sessionCache.get(key);
    if (!grant) return false;
    // Refresh LRU position so active grants outlive abandoned sessions.
    state.sessionCache.delete(key);
    state.sessionCache.set(key, grant);
    return true;
  }

  function cacheSessionGrant(key: string, grant: ScopedGrant): void {
    state.sessionCache.delete(key);
    state.sessionCache.set(key, grant);
    while (state.sessionCache.size > maxSessionCache) {
      const oldest = state.sessionCache.keys().next();
      if (oldest.done) break;
      state.sessionCache.delete(oldest.value);
    }
  }

  function sweepExpiredOneTimeGrants(now = Date.now()): void {
    for (const [key, entries] of state.oneTimeGrants) {
      const live = entries.filter(
        (entry) => now - entry.issuedAt <= ONE_TIME_GRANT_TTL_MS,
      );
      if (live.length === 0) {
        state.oneTimeGrants.delete(key);
      } else if (live.length !== entries.length) {
        state.oneTimeGrants.set(key, live);
      }
    }
  }

  function recordOneTimeGrant(
    key: string,
    grant: ScopedGrant,
    payload: unknown,
    now: number,
  ): void {
    const existing = state.oneTimeGrants.get(key) ?? [];
    const sameIndex = existing.findIndex((entry) =>
      samePayload(entry.payload, payload),
    );
    if (sameIndex >= 0) {
      existing.splice(sameIndex, 1);
    }
    existing.push({ grant, issuedAt: now, payload });
    if (existing.length > MAX_ONE_TIME_GRANTS_PER_KEY) {
      existing.splice(0, existing.length - MAX_ONE_TIME_GRANTS_PER_KEY);
    }
    state.oneTimeGrants.delete(key);
    state.oneTimeGrants.set(key, existing);

    let total = 0;
    for (const entries of state.oneTimeGrants.values()) {
      total += entries.length;
    }
    if (total > MAX_ONE_TIME_GRANTS_GLOBAL) {
      let excess = total - MAX_ONE_TIME_GRANTS_GLOBAL;
      for (const [bucketKey, entries] of state.oneTimeGrants) {
        if (excess <= 0) break;
        if (entries.length <= excess) {
          excess -= entries.length;
          state.oneTimeGrants.delete(bucketKey);
        } else {
          entries.splice(0, excess);
          excess = 0;
        }
      }
    }
  }

  function consumeOneTimeIfFresh(
    sessionId: string,
    pluginId: string,
    action: string,
    sessionScope: string,
    payload: unknown,
  ): boolean {
    sweepExpiredOneTimeGrants();
    const key = tripleKey(sessionId, sessionScope, pluginId, action);
    const entries = state.oneTimeGrants.get(key);
    if (!entries || entries.length === 0) return false;
    // `once` authorizes the exact dispatch shown in the approval dialog, not
    // an arbitrary later invocation that happens to share the action name.
    const matchIndex = entries.findIndex((entry) =>
      samePayload(entry.payload, payload),
    );
    if (matchIndex < 0) return false;
    entries.splice(matchIndex, 1);
    if (entries.length === 0) {
      state.oneTimeGrants.delete(key);
    }
    return true;
  }

  /**
   * Sweep stale pending entries (older than STALE_PENDING_TTL_MS). Called
   * opportunistically when reading or mutating pending state so the caller
   * pays for cleanup with no background timer needed.
   */
  function sweepStalePending(now = Date.now()): void {
    const cutoff = now - STALE_PENDING_TTL_MS;
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

  function clearGrantsMatching(
    matches: (sessionId: string, pluginId: string) => boolean,
  ): number {
    const now = Date.now();
    sweepStalePending(now);
    sweepExpiredOneTimeGrants(now);
    let cleared = 0;
    for (const [key, grant] of state.sessionCache) {
      if (matches(grant.sessionId, grant.pluginId)) {
        state.sessionCache.delete(key);
        cleared += 1;
      }
    }
    for (const [key, entries] of state.oneTimeGrants) {
      const first = entries[0];
      if (first && matches(first.grant.sessionId, first.grant.pluginId)) {
        state.oneTimeGrants.delete(key);
        cleared += entries.length;
      }
    }
    for (const [approvalId, pending] of state.pending) {
      if (matches(pending.record.sessionId, pending.record.pluginId)) {
        state.pending.delete(approvalId);
        cleared += 1;
      }
    }
    return cleared;
  }

  return {
    evaluate(input) {
      const sessionScope = resolveSessionScope(input.sessionScope);
      // 1. Builtin → always allowed, no dialog.
      if (isAutoTrusted(input.trustLevel)) {
        return { status: "allow", reason: "trusted" };
      }

      const policy = evaluatePolicy(input);
      if (policy.decision === "deny") {
        return {
          status: "denied",
          reason: policy.reason,
          ...(policy.capability ? { capability: policy.capability } : {}),
        };
      }
      if (policy.decision === "allow") {
        return { status: "allow", reason: policy.reason };
      }

      if (implicitlyGranted(input))
        return { status: "allow", reason: "trusted-source" };

      // 2. Session-level pre-authorization → always allowed.
      const key = tripleKey(
        input.sessionId,
        sessionScope,
        input.pluginId,
        input.action,
      );
      if (hasSessionCacheGrant(key)) {
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
      const now = Date.now();
      sweepStalePending(now);
      sweepExpiredOneTimeGrants(now);
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
        cacheSessionGrant(key, grant);
      } else {
        // Default scope is `once` — the next dispatch can use the grant
        // exactly once, then it is consumed. The TTL guards against stale
        // grants from a player that approved 10 minutes ago.
        recordOneTimeGrant(key, grant, pending.payload, now);
      }

      return { ok: true, pending };
    },

    listPending(sessionId, expectedSessionScope) {
      const resolvedScope = resolveSessionScope(expectedSessionScope);
      sweepStalePending();
      return [...state.pending.values()]
        .filter(
          (pending) =>
            pending.record.sessionId === sessionId &&
            pending.sessionScope === resolvedScope,
        )
        .map((pending) => pending.record);
    },

    listAllPendingForSession(sessionId) {
      sweepStalePending();
      return [...state.pending.values()]
        .filter((pending) => pending.record.sessionId === sessionId)
        .map((pending) => pending.record);
    },

    getPending(approvalId) {
      sweepStalePending();
      return state.pending.get(approvalId)?.record;
    },

    pendingMatchesScope(approvalId, expectedSessionScope) {
      const resolvedScope = resolveSessionScope(expectedSessionScope);
      sweepStalePending();
      return state.pending.get(approvalId)?.sessionScope === resolvedScope;
    },

    hasGrant(sessionId, pluginId, action, expectedSessionScope, ...payloadArg) {
      const exactKey = tripleKey(
        sessionId,
        resolveSessionScope(expectedSessionScope),
        pluginId,
        action,
      );
      const policy = evaluatePolicy({ sessionId, pluginId, action });
      if (policy.decision === "deny") return false;
      if (policy.decision === "allow") return true;
      if (implicitlyGranted({ sessionId, pluginId, action })) return true;
      if (hasSessionCacheGrant(exactKey)) {
        return true;
      }

      sweepExpiredOneTimeGrants();
      const entries = state.oneTimeGrants.get(exactKey);
      if (!entries || entries.length === 0) return false;
      if (payloadArg.length === 0) return true;
      return entries.some((entry) => samePayload(entry.payload, payloadArg[0]));
    },

    listSessionGrants(sessionId, scopeForPlugin) {
      const grants: { readonly pluginId: string; readonly action: string }[] =
        [];
      for (const grant of state.sessionCache.values()) {
        if (
          grant.sessionId === sessionId &&
          grant.sessionScope === scopeForPlugin(grant.pluginId)
        ) {
          grants.push({ pluginId: grant.pluginId, action: grant.action });
        }
      }
      return grants.sort((a, b) =>
        a.pluginId < b.pluginId
          ? -1
          : a.pluginId > b.pluginId
            ? 1
            : a.action < b.action
              ? -1
              : a.action > b.action
                ? 1
                : 0,
      );
    },

    revoke(sessionId, pluginId) {
      return clearGrantsMatching(
        (sid, pid) => sid === sessionId && (!pluginId || pid === pluginId),
      );
    },

    revokePlugin(pluginId) {
      return clearGrantsMatching((_sid, pid) => pid === pluginId);
    },
  };
}
