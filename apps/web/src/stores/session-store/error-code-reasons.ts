/**
 * Stable `error.occurred` codes shown in the player's language instead of the
 * server text. Values are i18n keys; codes not listed here fall back to the
 * server's `message`.
 */
const STALE_RETRY = "session.reasonRetryStale";
const ERROR_CODE_REASONS: ReadonlyMap<string, string> = new Map([
  ["session_busy", "session.reasonSessionBusy"],
  ["input_already_committed", "session.reasonInputAlreadyCommitted"],
  ["retry_source_not_found", STALE_RETRY],
  ["retry_source_not_committed", STALE_RETRY],
  ["retry_source_not_original", STALE_RETRY],
  ["retry_source_stale", STALE_RETRY],
  ["retry_target_not_active", STALE_RETRY],
  ["retry_target_not_failed", STALE_RETRY],
  ["recovery_unavailable", STALE_RETRY],
]);

/** The i18n key for a known error code, or `undefined` for anything else. */
export function errorCodeReason(code: unknown): string | undefined {
  return typeof code === "string" ? ERROR_CODE_REASONS.get(code) : undefined;
}
