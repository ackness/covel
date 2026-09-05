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
} from "@covel/shared";
import type { KernelStore } from "../commit/session-commit-pipeline.js";

export interface TraceRecorder {
  turnStarted(info: {
    runtimeCount: number;
    requestId?: string;
    origin?: "player" | "continuation";
    recoveryAction?: SessionExecutionStatus["retry"];
  }): Promise<void>;
  turnCompleted(
    info: {
      durationMs: number;
      resultCount: number;
      committed?: boolean;
    },
    settledRetryScope?: RuntimeRetryScope,
  ): Promise<void>;
  runtimeStarted(info: {
    runtimeId: string;
    pluginId: string;
    /** Named stage (setup/pre-turn/…); absent for event/manual/UI-only. */
    stage?: Stage;
  }): Promise<void>;
  runtimeCompleted(info: {
    runtimeId: string;
    pluginId: string;
    status: string;
    durationMs: number;
    error?: string;
  }): Promise<void>;
  runtimeFailed(info: {
    runtimeId: string;
    pluginId: string;
    error: string;
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
