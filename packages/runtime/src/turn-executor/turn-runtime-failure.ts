import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import { runPostRuntimeHook } from "../hooks/wire-helpers.js";
import { emitRuntimeFailed } from "../trace/runtime-telemetry.js";
import type { TurnExecutorDeps } from "./turn-executor-types.js";
import {
  getTurnExecutionSignal,
  isTurnExecutionAborted,
  RuntimeTimeoutError,
} from "./turn-control.js";

/** Shared failure boundary for scheduled and resumed execution. */
export async function finalizeRuntimeFailure(
  deps: TurnExecutorDeps,
  manifest: RuntimeManifest,
  input: TurnInput,
  result: RuntimeResult,
  cause?: unknown,
): Promise<RuntimeResult> {
  try {
    await deps.onRuntimeComplete?.({
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      status: result.status,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch {
    // A completion observer must not replace the execution failure.
  }
  emitRuntimeFailed(deps, input.sessionId, manifest, result);

  const finalized = await runPostRuntimeHook(
    {
      pipeline: deps.hookPipeline,
      signal: getTurnExecutionSignal(deps.turnControl),
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      eventBus: deps.eventBus,
      emitter: deps.emitter,
    },
    result,
  );
  // Hooks may recover business errors, but never expired or cancelled work.
  return cause instanceof RuntimeTimeoutError ||
    isTurnExecutionAborted(deps.turnControl)
    ? { ...finalized, status: "failed", output: null, error: result.error }
    : finalized;
}
