// @vitest-environment node
import { describe, expect, it } from "vitest";
import { errorCodeReason } from "../error-code-reasons.js";

describe("errorCodeReason", () => {
  it.each([
    ["session_busy", "session.reasonSessionBusy"],
    ["input_already_committed", "session.reasonInputAlreadyCommitted"],
    ["retry_source_not_found", "session.reasonRetryStale"],
    ["retry_source_not_committed", "session.reasonRetryStale"],
    ["retry_source_not_original", "session.reasonRetryStale"],
    ["retry_source_stale", "session.reasonRetryStale"],
    ["retry_target_not_active", "session.reasonRetryStale"],
    ["retry_target_not_failed", "session.reasonRetryStale"],
    ["recovery_unavailable", "session.reasonRetryStale"],
  ])("maps %s to %s", (code, key) => {
    expect(errorCodeReason(code)).toBe(key);
  });

  it.each([undefined, null, 42, "", "unknown_code", "toString"])(
    "has no reason for %s",
    (code) => {
      expect(errorCodeReason(code)).toBeUndefined();
    },
  );
});
