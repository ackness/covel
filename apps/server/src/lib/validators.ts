/**
 * Shared ID-validation regexes and helpers for API routes.
 *
 * Centralises the `worldId` / `sessionId` shape rules that were previously
 * duplicated across `session/request-helpers.ts`, `snapshots.ts`, and inline
 * in `install.ts`. Keeping a single source of truth avoids drift between the
 * validation rule and the error message that quotes it.
 */

import { canonicalizeLocale, DEFAULT_LOCALE } from "@covel/shared";

/** World id: 1–64 chars, alnum + `_` + `-`, case-insensitive. */
export const SAFE_WORLD_ID_RE = /^[a-z0-9_-]{1,64}$/i;

/** Session id: 1–128 chars, alnum + `_` + `-`, case-insensitive. */
export const SAFE_SESSION_ID_RE = /^[a-z0-9_-]{1,128}$/i;

/** Human-readable description of the world-id rule (for error messages). */
export const SAFE_WORLD_ID_DESC = "/^[a-z0-9_-]{1,64}$/i";

/** Human-readable description of the session-id rule (for error messages). */
export const SAFE_SESSION_ID_DESC = "/^[a-z0-9_-]{1,128}$/i";

/**
 * Normalize an untrusted `locale` input to its canonical safe value, otherwise
 * use the canonical fallback or registry default.
 * Never returns attacker-controlled text.
 */
export function normalizeLocale(
  value: unknown,
  fallback: string = DEFAULT_LOCALE,
): string {
  return (
    (typeof value === "string" ? canonicalizeLocale(value) : undefined) ??
    canonicalizeLocale(fallback) ??
    DEFAULT_LOCALE
  );
}
