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

/**
 * Locale tag: a simplified BCP-47 shape — a 2–3 letter primary subtag with an
 * optional single region/variant subtag (`zh`, `en-US`, `pt-BR`). Deliberately
 * strict: the value flows into locale-variant file-path construction
 * (`<name>.<lang>.<ext>`) and into localized prompt text, so it must never carry
 * `/`, `.`, whitespace, or attacker-controlled text.
 */
export const SAFE_LOCALE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;

/**
 * Normalize an untrusted `locale` input to a safe value: the input when it
 * matches {@link SAFE_LOCALE_RE}, otherwise the fallback (default `zh-CN`).
 * Never returns attacker-controlled text.
 */
export function normalizeLocale(value: unknown, fallback = "zh-CN"): string {
  return typeof value === "string" && SAFE_LOCALE_RE.test(value)
    ? value
    : fallback;
}
