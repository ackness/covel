/**
 * Shared ID-validation regexes and helpers for API routes.
 *
 * Centralises the `worldId` / `sessionId` shape rules that were previously
 * duplicated across `session/request-helpers.ts`, `snapshots.ts`, and inline
 * in `install.ts`. Keeping a single source of truth avoids drift between the
 * validation rule and the error message that quotes it.
 */

/** World id: 1–64 chars, alnum + `_` + `-`, case-insensitive. */
export const SAFE_WORLD_ID_RE = /^[a-z0-9_-]{1,64}$/i;

/** Session id: 1–128 chars, alnum + `_` + `-`, case-insensitive. */
export const SAFE_SESSION_ID_RE = /^[a-z0-9_-]{1,128}$/i;

/** Human-readable description of the world-id rule (for error messages). */
export const SAFE_WORLD_ID_DESC = "/^[a-z0-9_-]{1,64}$/i";

/** Human-readable description of the session-id rule (for error messages). */
export const SAFE_SESSION_ID_DESC = "/^[a-z0-9_-]{1,128}$/i";

/** Returns true when `id` is a syntactically valid world id. */
export function isValidWorldId(id: string): boolean {
  return SAFE_WORLD_ID_RE.test(id);
}

/** Returns true when `id` is a syntactically valid session id. */
export function isValidSessionId(id: string): boolean {
  return SAFE_SESSION_ID_RE.test(id);
}
