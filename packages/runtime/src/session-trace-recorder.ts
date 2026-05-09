/**
 * Trace recording
 *
 * Internal module split from session-kernel.ts. Keep public imports routed
 * through session-kernel.ts unless a caller intentionally needs this boundary.
 */

import type { KernelStore } from "./session-commit-pipeline.js";

export interface TraceRecorder {
  turnStarted(info: { runtimeCount: number }): Promise<void>;
  turnCompleted(info: {
    durationMs: number;
    resultCount: number;
  }): Promise<void>;
  runtimeStarted(info: {
    runtimeId: string;
    pluginId: string;
    priority: number | undefined;
  }): Promise<void>;
  runtimeCompleted(info: {
    runtimeId: string;
    pluginId: string;
    status: string;
    durationMs: number;
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
): TraceRecorder {
  async function record(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await store.addTraceEvent({
      id: crypto.randomUUID(),
      sessionId,
      type,
      traceId: turnId,
      turnId,
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  return {
    turnStarted: (info) => record("turn.started", info),
    turnCompleted: (info) => record("turn.completed", info),
    runtimeStarted: (info) => record("runtime.started", info),
    runtimeCompleted: (info) => record("runtime.completed", info),
    runtimeFailed: (info) => record("runtime.failed", info),
  };
}
