/** Runtime lifecycle notifications describe finalized execution, not commit. */

import {
  getRuntimeSpec,
  type RuntimeManifest,
  type RuntimeResult,
} from "@covel/shared";
import type { TurnEmitter } from "./turn-emitter.js";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";

/** Started execution retains its turn and invocation identity on every entry. */
export async function reportRuntimeStarted(
  deps: Pick<TurnExecutorDeps, "onRuntimeStart" | "eventBus">,
  sessionId: string,
  manifest: RuntimeManifest,
  identity: { readonly turnId: string; readonly runId: string },
): Promise<void> {
  const stage = getRuntimeSpec(manifest).stage;
  const payload = {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    ...identity,
    ...(stage !== undefined ? { stage } : {}),
  };
  try {
    await deps.onRuntimeStart?.(payload);
  } catch {
    console.warn("[runtime-telemetry] start observer failed", {
      runtimeId: manifest.name,
      runId: identity.runId,
    });
  }
  try {
    emitSubEvent(
      deps.eventBus,
      "runtime",
      "runtime.started",
      sessionId,
      payload,
    );
  } catch {
    console.warn("[runtime-telemetry] start delivery failed", {
      runtimeId: manifest.name,
      runId: identity.runId,
    });
  }
}

/** Report the finalized execution result, never a pre-Hook intermediate state. */
export async function reportRuntimeResult(
  deps: Pick<TurnExecutorDeps, "onRuntimeComplete" | "eventBus">,
  sessionId: string,
  result: RuntimeResult,
  reason?: string,
): Promise<void> {
  const payload = {
    runtimeId: result.runtimeId,
    pluginId: result.pluginId,
    turnId: result.turnId,
    runId: result.runId,
    status: result.status,
    durationMs: result.durationMs,
    ...(result.status === "failed" && result.error
      ? { error: result.error }
      : {}),
    ...(reason ? { reason } : {}),
  };
  try {
    await deps.onRuntimeComplete?.(payload);
  } catch {
    console.warn("[runtime-telemetry] completion observer failed", {
      runtimeId: result.runtimeId,
      runId: result.runId,
    });
  }
  try {
    emitSubEvent(
      deps.eventBus,
      "runtime",
      result.status === "failed" ? "runtime.failed" : "runtime.completed",
      sessionId,
      payload,
    );
  } catch {
    console.warn("[runtime-telemetry] terminal delivery failed", {
      runtimeId: result.runtimeId,
      runId: result.runId,
    });
  }
}

/**
 * Emit the compact `message.completed` trace event for a story runtime that
 * produced non-empty narrative content. No-op when there is no emitter or no
 * content. This is the single persisted record of the final aggregated content
 * + delta count, so the `/debug` timeline shows one row per runtime output
 * instead of thousands of per-token rows.
 */
export async function emitMessageCompleted(
  emitter: TurnEmitter | undefined,
  result: RuntimeResult,
  finalContent: string,
  deltaCount: number,
): Promise<void> {
  if (!emitter) return;
  await emitter.emit("message.completed", {
    runtimeId: result.runtimeId,
    pluginId: result.pluginId,
    turnId: result.turnId,
    runId: result.runId,
    content: finalContent,
    len: finalContent.length,
    deltaCount,
  });
}
