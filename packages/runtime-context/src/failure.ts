import type { RecordStatus, PublishedRecord } from "@covel/services";
import type { RuntimeExecutionResult } from "./types.js";

/**
 * Create a standardized RuntimeExecutionResult for any terminal status.
 */
export function createResult(
  status: RecordStatus,
  payload: unknown,
  failureReason?: string,
): RuntimeExecutionResult {
  return { status, payload, failureReason };
}

export function successResult(payload: unknown): RuntimeExecutionResult {
  return createResult("success", payload);
}

export function failedResult(reason: string, payload?: unknown): RuntimeExecutionResult {
  return createResult("failed", payload ?? null, reason);
}

export function approvalDeniedResult(reason?: string): RuntimeExecutionResult {
  return createResult("approval_denied", null, reason ?? "User denied approval.");
}

export function skippedConditionResult(reason: string): RuntimeExecutionResult {
  return createResult("skipped_condition", null, reason);
}

export function skippedLimitResult(reason: string): RuntimeExecutionResult {
  return createResult("skipped_limit", null, reason);
}

/**
 * Wrap a RuntimeExecutionResult into a full PublishedRecord envelope.
 */
export function wrapAsPublishedRecord(
  result: RuntimeExecutionResult,
  envelope: {
    recordType?: string;
    pluginId: string;
    runtimeId: string;
    sessionId: string;
    turnId: string;
    runId: string;
    traceId: string;
    locale: string;
  },
): PublishedRecord {
  return {
    recordType: envelope.recordType ?? "runtime_result",
    pluginId: envelope.pluginId,
    runtimeId: envelope.runtimeId,
    sessionId: envelope.sessionId,
    turnId: envelope.turnId,
    runId: envelope.runId,
    traceId: envelope.traceId,
    status: result.status,
    timestamp: new Date().toISOString(),
    locale: envelope.locale,
    payload: result.payload,
    failureReason: result.failureReason,
  };
}
