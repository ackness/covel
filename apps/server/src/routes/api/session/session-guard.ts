/**
 * Session-param resolution guard + session owner-token authorization.
 *
 * 13 session-scoped route files repeated the same pattern:
 *
 *   const session = await store.getSession(id);
 *   if (!session) return c.json({ error: "Session not found" }, 404);
 *
 * with several incompatible 404 bodies (`{error}`, `Session not found: <id>`,
 * `{status,error}`, `{error,code}`). `resolveSessionParam` centralises this so
 * every session-scoped 404 returns the unified envelope:
 *
 *   { "error": "Session not found: <id>", "code": "session_not_found" }
 *
 * Routes call `resolveSessionParam(c)` and branch on the discriminated result.
 *
 * ── Owner-token model ───────────────────────────────
 *
 * Every session created via `POST /api/sessions` mints an unguessable owner
 * token. Only its SHA-256 hash is persisted (`session.metadata.ownerTokenHash`)
 * — the raw token is returned exactly once in the create response, so no read
 * endpoint can ever leak it. Callers present it via `Authorization: Bearer`,
 * `X-Session-Token`, or `?session_token=` (SSE/EventSource cannot set headers).
 *
 * Tiered enforcement:
 *   - `self` (default) / desktop / dev: NOT enforced. Single-user local play
 *     must keep working token-free; the network boundary for these tiers is
 *     the loopback bind in `index.ts` (COVEL_BIND_HOST=127.0.0.1 default).
 *   - `demo` / `commercial`: hard-required on every session-scoped route that
 *     goes through this guard. Sessions without a stored hash fail closed.
 *     The operator token (COVEL_DESKTOP_REST_TOKEN) acts as a master key.
 *   - production + MemoryStore: hard-required as well. This is the anonymous
 *     browser-private profile: durable data lives in each browser, while the
 *     shared server only holds transient execution mirrors. Anonymous session
 *     creation stays open, but one player cannot read another player's mirror.
 *
 * CORS remains a browser policy only — it is never relied on for authz.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { DataStore, SessionRecord } from "@covel/store";
import { readRuntimeEnv } from "@covel/shared";
import { errorBody } from "../../../api-error.js";
import type { SessionLock } from "../../../lib/session-lock.js";

export const SESSION_NOT_FOUND_CODE = "session_not_found";
export const SESSION_OWNER_REQUIRED_CODE = "session_owner_required";
export const OPERATOR_TOKEN_REQUIRED_CODE = "operator_token_required";
export const SESSION_INCARNATION_CHANGED_CODE = "session_incarnation_changed";

/** Metadata key holding the SHA-256 hex hash of the session owner token. */
export const SESSION_OWNER_TOKEN_HASH_KEY = "ownerTokenHash";
/** Private metadata key that identifies one persisted session incarnation. */
export const SESSION_APPROVAL_SCOPE_KEY = "approvalScopeNonce";
/** Private per-plugin revocation generations within the session scope. */
export const SESSION_APPROVAL_REVISIONS_KEY = "approvalScopeRevisions";
/** Private immutable identity for sessions that do not carry an owner hash. */
export const SESSION_INCARNATION_KEY = "sessionIncarnationNonce";
/** Private marker that keeps a failed/in-progress delete fail-closed. */
export const SESSION_DELETION_PENDING_KEY = "deletionPendingNonce";
/** Private lease timestamp for crash-safe deletion takeover. */
export const SESSION_DELETION_STARTED_AT_KEY = "deletionStartedAt";
/** Private marker that lets one later DELETE retry a failed cleanup. */
export const SESSION_DELETION_RETRY_KEY = "deletionRetryNonce";
/** Private generation recording that SessionEnd already ran for a delete. */
export const SESSION_DELETION_END_FIRED_KEY = "deletionEndHookFiredNonce";
/** Private lease for an observe-only SessionStart/SessionEnd callback. */
export const SESSION_LIFECYCLE_PENDING_KEY = "sessionLifecyclePending";

/** Remove framework-private credentials/capability generations from metadata. */
export function publicSessionMetadata(
  metadata: SessionRecord["metadata"],
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const {
    [SESSION_OWNER_TOKEN_HASH_KEY]: _ownerHash,
    [SESSION_APPROVAL_SCOPE_KEY]: _approvalScope,
    [SESSION_APPROVAL_REVISIONS_KEY]: _approvalRevisions,
    [SESSION_INCARNATION_KEY]: _incarnation,
    [SESSION_DELETION_PENDING_KEY]: _deletionPending,
    [SESSION_DELETION_STARTED_AT_KEY]: _deletionStartedAt,
    [SESSION_DELETION_RETRY_KEY]: _deletionRetry,
    [SESSION_DELETION_END_FIRED_KEY]: _deletionEndFired,
    [SESSION_LIFECYCLE_PENDING_KEY]: _lifecyclePending,
    ...rest
  } = metadata;
  return rest;
}

type ResolveResult =
  | { readonly ok: true; readonly session: SessionRecord }
  | { readonly ok: false; readonly response: Response };

export function hashSessionOwnerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a fresh owner token. The raw token is returned to the client once. */
export function mintSessionOwnerToken(): {
  readonly token: string;
  readonly tokenHash: string;
} {
  const token = randomUUID();
  return { token, tokenHash: hashSessionOwnerToken(token) };
}

/** Mint a private, persisted capability scope for a newly created session. */
export function mintSessionApprovalScope(): string {
  return randomUUID();
}

/** Stable identity used to reject stale mutations after same-id recreation. */
export function sessionIncarnationIdentity(session: SessionRecord): string {
  const ownerHash = session.metadata?.[SESSION_OWNER_TOKEN_HASH_KEY];
  if (typeof ownerHash === "string" && ownerHash.length > 0) {
    return `owner:${ownerHash}`;
  }
  const nonce = session.metadata?.[SESSION_INCARNATION_KEY];
  if (typeof nonce === "string" && nonce.length > 0) {
    return `incarnation:${nonce}`;
  }
  return `created:${session.createdAt}`;
}

/**
 * Short commit barrier for session-scoped mutations.
 *
 * Callers parse/validate bodies and perform non-mutating expensive work before
 * entering. The callback runs under the cross-Pod session lock only after the
 * owner, immutable incarnation, deletion marker and explicit status policy are
 * revalidated against the live row.
 */
export async function withLockedSessionMutation<T>(options: {
  readonly c: Context;
  readonly store: DataStore;
  readonly sessionLock: SessionLock;
  readonly sessionId: string;
  readonly expectedSession: SessionRecord;
  readonly allowedStatuses: "any" | readonly string[];
  readonly allowDeletionPending?: boolean;
  readonly mutate: (session: SessionRecord) => Promise<T>;
}): Promise<T | Response> {
  return options.sessionLock.withLock(options.sessionId, async () => {
    const live = await options.store.getSession(options.sessionId);
    if (!live) {
      return options.c.json(
        errorBody(`Session not found: ${options.sessionId}`, {
          code: SESSION_NOT_FOUND_CODE,
        }),
        404,
      );
    }
    const ownerDenied = checkSessionOwner(options.c, live);
    if (ownerDenied) return ownerDenied;
    if (
      sessionIncarnationIdentity(live) !==
      sessionIncarnationIdentity(options.expectedSession)
    ) {
      return options.c.json(
        errorBody("Session was replaced while the request was waiting", {
          code: "session_incarnation_changed",
        }),
        409,
      );
    }
    if (
      !options.allowDeletionPending &&
      live.metadata?.[SESSION_DELETION_PENDING_KEY]
    ) {
      return options.c.json(
        errorBody("Session deletion is in progress; retry DELETE", {
          code: "session_deleting",
        }),
        409,
      );
    }
    if (
      options.allowedStatuses !== "any" &&
      !options.allowedStatuses.includes(live.status)
    ) {
      return options.c.json(
        errorBody(`Session is ${live.status}; mutation refused`, {
          code: "session_not_active",
        }),
        409,
      );
    }
    return options.mutate(live);
  });
}

/**
 * Resolve the stable scope used by process-local approval gates.
 *
 * New sessions carry a dedicated random nonce. The owner-token hash is a safe
 * compatibility fallback for sessions created before the nonce was added: it
 * is already random, private, persisted, and changes when an id is recreated.
 * The timestamp fallback is only for legacy/test rows that have neither key.
 */
export function sessionApprovalScope(
  session: SessionRecord,
  pluginId: string,
): string {
  const nonce = session.metadata?.[SESSION_APPROVAL_SCOPE_KEY];
  const ownerHash = session.metadata?.[SESSION_OWNER_TOKEN_HASH_KEY];
  const incarnation =
    typeof nonce === "string" && nonce.length > 0
      ? `nonce:${nonce}`
      : typeof ownerHash === "string" && ownerHash.length > 0
        ? `owner:${ownerHash}`
        : `created:${session.createdAt}`;
  const revisions = session.metadata?.[SESSION_APPROVAL_REVISIONS_KEY];
  const revision =
    revisions && typeof revisions === "object" && !Array.isArray(revisions)
      ? (revisions as Record<string, unknown>)[pluginId]
      : undefined;
  return JSON.stringify([
    incarnation,
    typeof revision === "string" && revision.length > 0 ? revision : "0",
  ]);
}

/**
 * Build a metadata patch that invalidates one plugin or every plugin without
 * relying on process-local cache eviction or cross-Pod broadcasts.
 */
export function rotateSessionApprovalScope(
  session: SessionRecord,
  pluginId?: string,
): Record<string, unknown> {
  const metadata = { ...session.metadata };
  if (!pluginId) {
    metadata[SESSION_APPROVAL_SCOPE_KEY] = mintSessionApprovalScope();
    // Session metadata patches merge with the existing object. `undefined`
    // is the deletion tombstone (and disappears when SQL JSON is serialised);
    // `delete` here would let old plugin revisions merge back in.
    metadata[SESSION_APPROVAL_REVISIONS_KEY] = undefined;
    return metadata;
  }
  const rawRevisions = metadata[SESSION_APPROVAL_REVISIONS_KEY];
  const revisions: Record<string, unknown> =
    rawRevisions &&
    typeof rawRevisions === "object" &&
    !Array.isArray(rawRevisions)
      ? {
          ...(rawRevisions as Record<string, unknown>),
          [pluginId]: randomUUID(),
        }
      : { [pluginId]: randomUUID() };
  metadata[SESSION_APPROVAL_REVISIONS_KEY] = revisions;
  return metadata;
}

/**
 * Constant-time string comparison. Both inputs are re-hashed to fixed-length
 * digests so `timingSafeEqual` never throws on length mismatch and the
 * comparison leaks neither content nor length.
 */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

/**
 * Extract the caller-presented session token. Query-param fallback exists for
 * EventSource (SSE) clients, which cannot set request headers.
 */
export function extractSessionOwnerToken(c: Context): string | undefined {
  const auth = (c.req.header("authorization") ?? "").trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  if (bearer) return bearer;
  const header = c.req.header("x-session-token")?.trim();
  if (header) return header;
  const query = c.req.query("session_token")?.trim();
  return query || undefined;
}

/** Owner-token enforcement is a hosted-tier posture only. */
export function isOwnerAuthEnforced(
  tier: string = readRuntimeEnv().deploymentTier,
): boolean {
  return tier === "demo" || tier === "commercial";
}

/** Request-aware owner guard, including the anonymous browser-private tier. */
export function isSessionOwnerAuthEnforced(c: Context): boolean {
  if (isOwnerAuthEnforced()) return true;
  const env = readRuntimeEnv();
  return c.get("storeBackend") === "memory" && env.nodeEnv === "production";
}

/**
 * True when the caller presented the operator master token
 * (COVEL_DESKTOP_REST_TOKEN) — used to admit privileged tooling to
 * cross-session surfaces (e.g. the session listing) on hosted tiers.
 */
export function hasOperatorToken(c: Context): boolean {
  const expected = readRuntimeEnv().desktopRestToken;
  if (!expected) return false;
  const provided = extractSessionOwnerToken(c);
  return provided !== undefined && safeEqual(provided, expected);
}

/** Require the configured operator credential for global hosted mutations. */
export function checkHostedOperator(c: Context): Response | undefined {
  if (!isOwnerAuthEnforced()) return undefined;
  if (hasOperatorToken(c)) return undefined;
  return c.json(
    errorBody("Operator token required on this tier", {
      code: OPERATOR_TOKEN_REQUIRED_CODE,
    }),
    401,
  );
}

/**
 * Authorize the request against the session's owner token.
 *
 * Returns `undefined` when access is allowed, or a ready-to-return 401
 * response when a hosted tier requires a token the caller did not present.
 * Non-hosted tiers (`self`, unset) always allow — see module doc.
 */
export function checkSessionOwner(
  c: Context,
  session: SessionRecord,
): Response | undefined {
  const env = readRuntimeEnv();
  if (!isSessionOwnerAuthEnforced(c)) return undefined;

  const provided = extractSessionOwnerToken(c);
  if (provided) {
    // Operator master token — admin tooling / e2e harnesses.
    if (env.desktopRestToken && safeEqual(provided, env.desktopRestToken)) {
      return undefined;
    }
    const expected = session.metadata?.[SESSION_OWNER_TOKEN_HASH_KEY];
    if (
      typeof expected === "string" &&
      safeEqual(hashSessionOwnerToken(provided), expected)
    ) {
      return undefined;
    }
  }

  // Fail closed: sessions without a stored hash predate this guard; on hosted
  // tiers they are only reachable with the operator token.
  return c.json(
    errorBody("Session owner token missing or invalid", {
      code: SESSION_OWNER_REQUIRED_CODE,
    }),
    401,
  );
}

/**
 * Owner guard for routes whose session id arrives outside the `:id` route
 * param (query string, request body, or an indirection like approvalId →
 * pending.sessionId).
 *
 * Returns `undefined` when access is allowed, else a ready-to-return 404
 * (unknown session) or 401 (owner token missing/invalid) response.
 *
 * Strict no-op on non-hosted tiers — not even a store lookup — because
 * several of these routes historically accepted session ids with no
 * existence requirement (e.g. approvals listing) and self-tier behavior
 * must not change.
 */
export async function checkSessionOwnerById(
  c: Context,
  store: DataStore,
  sessionId: string,
): Promise<Response | undefined> {
  if (!isSessionOwnerAuthEnforced(c)) return undefined;
  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json(
      errorBody(`Session not found: ${sessionId}`, {
        code: SESSION_NOT_FOUND_CODE,
      }),
      404,
    );
  }
  const denied = checkSessionOwner(c, session);
  if (denied) return denied;
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    c.set("sessionReadIncarnation", {
      sessionId,
      identity: sessionIncarnationIdentity(session),
    });
  }
  return undefined;
}

/**
 * Look up the session named by the `:id` (or `:sessionId`) route param and
 * enforce owner-token authorization on hosted tiers. On miss, the returned
 * `response` is a ready-to-return 404 (unknown session) or 401 (owner token
 * required) with the unified error envelope.
 */
export async function resolveSessionParam(
  c: Context,
  paramName: "id" | "sessionId" = "id",
): Promise<ResolveResult> {
  const store = c.get("store");
  const sessionId = c.req.param(paramName) ?? "";
  const session = await store.getSession(sessionId);
  if (!session) {
    return {
      ok: false,
      response: c.json(
        errorBody(`Session not found: ${sessionId}`, {
          code: SESSION_NOT_FOUND_CODE,
        }),
        404,
      ),
    };
  }
  const denied = checkSessionOwner(c, session);
  if (denied) {
    return { ok: false, response: denied };
  }
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    c.set("sessionReadIncarnation", {
      sessionId,
      identity: sessionIncarnationIdentity(session),
    });
  }
  return { ok: true, session };
}

/**
 * Response-side half of the session read barrier.
 *
 * A route may authorize an old session row, yield during its data lookup, and
 * then read a newly-created session with the same public id. Rechecking after
 * the handler finishes turns that interleaving into a 409 instead of returning
 * data from an incarnation the caller never authorized.
 */
export async function verifyResolvedSessionRead(
  c: Context,
): Promise<Response | undefined> {
  const expected = c.get("sessionReadIncarnation");
  if (!expected) return undefined;
  const live = await c.get("store").getSession(expected.sessionId);
  if (live && sessionIncarnationIdentity(live) === expected.identity) {
    return undefined;
  }
  return c.json(
    errorBody("Session was replaced while the request was reading", {
      code: SESSION_INCARNATION_CHANGED_CODE,
    }),
    409,
  );
}
