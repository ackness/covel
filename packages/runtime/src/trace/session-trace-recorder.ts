/**
 * Trace recording
 *
 * Internal module split from session-kernel.ts. Keep public imports routed
 * through session-kernel.ts unless a caller intentionally needs this boundary.
 */

import type {
  RuntimeRetryScope,
  SessionExecutionStatus,
  Stage,
  TurnAction,
} from "@covel/shared";
import type { KernelStore } from "../commit/session-commit-pipeline.js";

export interface TraceRecorder {
  turnStarted(info: {
    runtimeCount: number;
    requestId?: string;
    origin?: "player" | "continuation";
    recoveryAction?: SessionExecutionStatus["retry"];
    /**
     * The player's resolved actions and the id their chat row is saved
     * under. A `retry_turn` of a turn that answered an interaction runs
     * again from these, since the answer itself is already stored.
     */
    playerInput?: {
      readonly actions: readonly TurnAction[];
      readonly messageId: string;
    };
  }): Promise<void>;
  turnCompleted(
    info: {
      durationMs: number;
      resultCount: number;
      committed?: boolean;
      abortReason?: string;
    },
    settledRetryScope?: RuntimeRetryScope,
  ): Promise<void>;
  runtimeStarted(info: {
    runtimeId: string;
    pluginId: string;
    runId?: string;
    turnId?: string;
    /** Named stage (setup/pre-turn/…); absent for event/manual/UI-only. */
    stage?: Stage;
  }): Promise<void>;
  runtimeCompleted(info: {
    runtimeId: string;
    pluginId: string;
    runId?: string;
    turnId?: string;
    status: string;
    durationMs: number;
    error?: string;
    /** How the agent loop ended; agent runtimes only. */
    stopReason?: import("@covel/shared").StopReason;
    /** Why a skipped runtime did not run (a gate code). */
    reason?: string;
  }): Promise<void>;
  runtimeFailed(info: {
    runtimeId: string;
    pluginId: string;
    runId?: string;
    turnId?: string;
    error: string;
    errorKind?: import("@covel/shared").ProviderFailureKind;
    failureTarget?: import("@covel/shared").RuntimeResult["failureTarget"];
    stopReason?: import("@covel/shared").StopReason;
    status?: string;
    durationMs?: number;
  }): Promise<void>;
}

export function createTraceRecorder(
  store: Pick<KernelStore, "addTraceEvent">,
  sessionId: string,
  turnId: string,
  /**
   * Correlation id for persisted rows. Pass the action stream's SSE traceId
   * so recorder rows share one traceId with emitter + commit-pipeline rows
   * so the whole turn reads as one timeline. Falls back to turnId for
   * callers without an SSE stream.
   */
  traceId?: string,
  retryScope?: RuntimeRetryScope,
): TraceRecorder {
  const effectiveTraceId = traceId ?? turnId;
  async function record(
    type: string,
    payload: Record<string, unknown>,
    scope: RuntimeRetryScope | undefined = retryScope,
  ): Promise<void> {
    await store.addTraceEvent({
      id: crypto.randomUUID(),
      sessionId,
      type,
      traceId: effectiveTraceId,
      turnId,
      payload: { ...payload, ...scope },
      createdAt: new Date().toISOString(),
    });
  }

  return {
    turnStarted: (info) => record("turn.started", info),
    turnCompleted: (info, settledRetryScope) =>
      record("turn.completed", info, settledRetryScope),
    runtimeStarted: (info) => record("runtime.started", info),
    runtimeCompleted: (info) => record("runtime.completed", info),
    runtimeFailed: (info) => record("runtime.failed", info),
  };
}
