import type {
  LLMTargetIdentity,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
} from "@covel/shared";
import { validateOutput } from "@covel/tools";
import {
  runPostRuntimeHook,
  runPreRuntimeHook,
} from "../hooks/wire-helpers.js";
import { storyOutputError } from "../agent-loop/story-output.js";
import { withAgentFailureTarget } from "../agent-loop/runtime-completion.js";
import {
  emitMessageCompleted,
  reportRuntimeResult,
} from "../trace/runtime-telemetry.js";
import type { TurnExecutorDeps } from "./turn-executor-types.js";
import { guardProvidedValue, isGuardProvided } from "./guard-output.js";
import {
  getTurnExecutionSignal,
  RuntimeTimeoutError,
  throwIfTurnExecutionAborted,
} from "./turn-control.js";

type FinalizationDeps = Pick<
  TurnExecutorDeps,
  "hookPipeline" | "turnControl" | "onRuntimeComplete" | "eventBus" | "emitter"
> &
  Partial<Pick<TurnExecutorDeps, "loadRuntime">>;

/** Apply plugin policy once before dispatching an agent, function or guard. */
export async function runRuntimePreHook(
  deps: FinalizationDeps,
  manifest: RuntimeManifest,
  input: TurnInput,
  runId: string,
  startTime: number,
): Promise<RuntimeResult | undefined> {
  throwIfTurnExecutionAborted(deps.turnControl, "PreRuntime entry");
  const hook = await runPreRuntimeHook({
    pipeline: deps.hookPipeline,
    signal: getTurnExecutionSignal(deps.turnControl),
    sessionId: input.sessionId,
    turnId: input.turnId,
    manifest,
    input,
    eventBus: deps.eventBus,
    emitter: deps.emitter,
  });
  throwIfTurnExecutionAborted(deps.turnControl, "PreRuntime");
  if (hook.action !== "abort") return undefined;
  return finalizeRuntimeResult(deps, manifest, input, {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: input.turnId,
    status: "skipped",
    output: { skipped: true, reason: hook.reason },
    toolCalls: [],
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  });
}

/** Finalize policy before publishing the single execution terminal result. */
export async function finalizeRuntimeResult(
  deps: FinalizationDeps,
  manifest: RuntimeManifest,
  input: TurnInput,
  result: RuntimeResult,
  options: {
    readonly cause?: unknown;
    readonly lastTarget?: LLMTargetIdentity;
    readonly deltaCount?: number;
    readonly outputContractSchema?: Readonly<Record<string, unknown>>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<RuntimeResult> {
  result = withAgentFailureTarget(result, options.lastTarget);
  let finalized = await runPostRuntimeHook(
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
  const signal = getTurnExecutionSignal(deps.turnControl);
  if (options.cause instanceof RuntimeTimeoutError || signal?.aborted) {
    finalized = {
      ...finalized,
      status: "failed",
      output: null,
      error:
        options.cause instanceof RuntimeTimeoutError
          ? options.cause.message
          : signal?.reason instanceof Error
            ? signal.reason.message
            : "Runtime execution was cancelled",
    };
  } else if (
    manifest.outputKind === "story" &&
    finalized.status === "success"
  ) {
    const error = storyOutputError(finalized.output);
    if (error)
      finalized = { ...finalized, status: "failed", output: null, error };
  }
  if (
    finalized.status === "success" &&
    finalized.canonicalValue?.value !== undefined &&
    options.outputSchema
  ) {
    let error: string | undefined;
    try {
      const validation = validateOutput(
        finalized.canonicalValue.value,
        options.outputSchema,
      );
      if (!validation.valid)
        error = (validation.errors ?? []).slice(0, 5).join("; ");
    } catch {
      error = "schema could not be compiled or output could not be validated";
    }
    if (error !== undefined)
      finalized = {
        ...finalized,
        status: "failed",
        output: null,
        error: `output-schema-invalid: ${error}`,
      };
  }
  const guardProvided = isGuardProvided(finalized);
  if (
    manifest.outputContract &&
    (finalized.status === "success" || guardProvided)
  ) {
    let contractError: string | undefined;
    try {
      // Normal dispatch supplies the already loaded schema. A hook can also
      // recover a pre-dispatch failure; that path must pass the same gate.
      const schema = Object.hasOwn(options, "outputContractSchema")
        ? options.outputContractSchema
        : (await deps.loadRuntime?.(manifest, input.locale, input.sessionId))
            ?.outputContractSchema;
      const validation = schema
        ? validateOutput(
            finalized.canonicalValue
              ? finalized.canonicalValue.value
              : guardProvided
                ? guardProvidedValue(finalized.output)
                : finalized.output,
            schema,
          )
        : undefined;
      if (
        finalized.canonicalValue &&
        finalized.canonicalValue.value === undefined
      ) {
        contractError = "canonical value unavailable after output rewrite";
      } else if (validation && !validation.valid)
        contractError = (validation.errors ?? []).slice(0, 5).join("; ");
    } catch {
      // Loading and compiling a third-party schema can fail. Finalization has
      // already run PostRuntime, so return one failed terminal instead of
      // throwing into the dispatch catch and invoking the hook a second time.
      contractError = "contract schema could not be loaded or compiled";
    }
    if (contractError !== undefined)
      finalized = {
        ...finalized,
        status: "failed",
        output: null,
        error: `contract-output-invalid (${manifest.outputContract}): ${contractError}`,
      };
  }
  finalized = withAgentFailureTarget(finalized, options.lastTarget);
  if (manifest.outputKind === "story" && finalized.status === "success") {
    const output = finalized.output as Record<string, unknown>;
    const content =
      typeof output.narrativeOutput === "string"
        ? output.narrativeOutput
        : typeof output.content === "string"
          ? output.content
          : "";
    try {
      await emitMessageCompleted(
        deps.emitter,
        finalized,
        content,
        options.deltaCount ?? 0,
      );
    } catch {
      // Trace delivery cannot turn a finished execution into another Hook run.
      console.warn("[runtime-telemetry] message delivery failed", {
        runtimeId: finalized.runtimeId,
        runId: finalized.runId,
      });
    }
  }
  await reportRuntimeResult(deps, input.sessionId, finalized);
  return finalized;
}
