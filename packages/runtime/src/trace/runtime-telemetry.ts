/**
 * Runtime-level telemetry helpers for agent runtimes.
 *
 * `turn-agent-runtime.ts` emits `runtime.failed` on each early-return failure
 * path and `runtime.completed` / `message.completed` on the success path. These
 * thin wrappers centralise the event payload shapes so the runtime body reads
 * as orchestration rather than event plumbing.
 */

import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import type { TurnEmitter } from "./turn-emitter.js";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";

/** Emit a `runtime.failed` sub-event for a failed RuntimeResult. */
export function emitRuntimeFailed(
  deps: TurnExecutorDeps,
  sessionId: string,
  manifest: RuntimeManifest,
  result: RuntimeResult,
): void {
  emitSubEvent(deps.eventBus, "runtime", "runtime.failed", sessionId, {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    status: result.status,
    durationMs: result.durationMs,
    error: result.error,
  });
}

/** Emit a `runtime.completed` sub-event for a finished RuntimeResult. */
export function emitRuntimeCompleted(
  deps: TurnExecutorDeps,
  sessionId: string,
  manifest: RuntimeManifest,
  result: RuntimeResult,
): void {
  emitSubEvent(deps.eventBus, "runtime", "runtime.completed", sessionId, {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    status: result.status,
    durationMs: result.durationMs,
  });
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
  manifest: RuntimeManifest,
  finalContent: string,
  deltaCount: number,
): Promise<void> {
  if (!emitter) return;
  await emitter.emit("message.completed", {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    content: finalContent,
    len: finalContent.length,
    deltaCount,
  });
}
