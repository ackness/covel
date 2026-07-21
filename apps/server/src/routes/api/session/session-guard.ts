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
 *
 * CORS remains a browser policy only — it is never relied on for authz.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { DataStore, SessionRecord } from "@covel/store";
import { readRuntimeEnv } from "@covel/shared";
import { errorBody } from "../../../api-error.js";

export const SESSION_NOT_FOUND_CODE = "session_not_found";
export const SESSION_OWNER_REQUIRED_CODE = "session_owner_required";
export const OPERATOR_TOKEN_REQUIRED_CODE = "operator_token_required";

/** Metadata key holding the SHA-256 hex hash of the session owner token. */
export const SESSION_OWNER_TOKEN_HASH_KEY = "ownerTokenHash";

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
  if (!isOwnerAuthEnforced(env.deploymentTier)) return undefined;

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
  if (!isOwnerAuthEnforced()) return undefined;
  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json(
      errorBody(`Session not found: ${sessionId}`, {
        code: SESSION_NOT_FOUND_CODE,
      }),
      404,
    );
  }
  return checkSessionOwner(c, session);
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
  return { ok: true, session };
}
