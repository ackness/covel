import { stopOf } from "../agent-loop/stop-reason.js";
import {
  CONCEALED_FAILURE_MESSAGE,
  isSetupRuntime,
  type LLMTargetIdentity,
  type RuntimeManifest,
  type RuntimeResult,
  type TurnInput,
} from "@covel/shared";
import { AiProviderError, classifyProviderFailure } from "@covel/ai-provider";
import { LLMRetryError } from "../retry/retry-common.js";
import { serviceFailureOf } from "../plugin-services.js";
import { isDeepStrictEqual } from "node:util";
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

/** The exception behind a failure once retry wrappers are peeled off. */
function unwrapRetryCause(cause: unknown): unknown {
  let current = cause;
  for (let depth = 0; depth < 8 && current instanceof LLMRetryError; depth++)
    current = current.cause;
  return current;
}

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
    /**
     * An agent has no canonical value: its output was checked against this
     * schema before PostRuntime and is checked again only when a hook rewrote it.
     */
    readonly agentOutputSchema?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<RuntimeResult> {
  result = withAgentFailureTarget(result, options.lastTarget);
  // Provider provenance belongs to the original exception, so it is read here,
  // before a PostRuntime hook can sanitize or translate the error text.
  const providerThrown =
    unwrapRetryCause(options.cause) instanceof AiProviderError;
  const preHookOutput = result.output;
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
  // A hook that turns a failed or skipped result into success must pass the
  // same `output.schema` gate as a normal success. Such a result has no
  // canonical value, so its `output` is what downstream inputs read.
  const recovered =
    result.status !== "success" && finalized.status === "success";
  const schemaTarget =
    finalized.canonicalValue?.value !== undefined
      ? { schema: options.outputSchema, value: finalized.canonicalValue.value }
      : !finalized.canonicalValue &&
          manifest.outputKind !== "story" &&
          (recovered || !isDeepStrictEqual(finalized.output, preHookOutput))
        ? {
            schema: options.agentOutputSchema ?? options.outputSchema,
            value: finalized.output,
          }
        : undefined;
  if (finalized.status === "success" && schemaTarget) {
    let error: string | undefined;
    let schema = schemaTarget.schema;
    if (
      !schema &&
      recovered &&
      !Object.hasOwn(options, "outputSchema") &&
      !Object.hasOwn(options, "agentOutputSchema")
    ) {
      // A failure before dispatch (missing handler, thrown error) finalizes
      // without the loaded schemas; a recovery from it loads them here.
      try {
        schema = (
          await deps.loadRuntime?.(manifest, input.locale, input.sessionId)
        )?.outputSchema;
      } catch {
        error = "schema could not be loaded";
      }
    }
    if (schema && error === undefined) {
      try {
        const validation = validateOutput(schemaTarget.value, schema);
        if (!validation.valid)
          error = (validation.errors ?? []).slice(0, 5).join("; ");
      } catch {
        error = "schema could not be compiled or output could not be validated";
      }
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
  // Classify the original exception while its structured provider details still
  // exist. Retry wrappers keep that exception in cause; error text cannot
  // distinguish a quota 429 from an ordinary rate limit.
  if (
    finalized.status === "failed" &&
    finalized.error === result.error &&
    options.cause !== undefined &&
    !signal?.aborted
  ) {
    const cause = unwrapRetryCause(options.cause);
    finalized = {
      ...finalized,
      errorKind: classifyProviderFailure(cause).kind,
      ...(cause instanceof AiProviderError
        ? {
            failureTarget: {
              provider: cause.provider,
              ...(cause.model ? { model: cause.model } : {}),
            },
          }
        : {}),
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
  if (manifest.concealed && finalized.status === "failed" && finalized.error) {
    // The failure text can quote hidden content (tool validation messages), and
    // it reaches the player stream, traces and the stored result.
    console.warn("[runtime] concealed runtime failed", {
      runtimeId: finalized.runtimeId,
      runId: finalized.runId,
      error: finalized.error,
    });
    // The provider and model name no hidden content, and they tell the player
    // which model to look at.
    const target = /^\[provider: [^\]]*\] /.exec(finalized.error)?.[0] ?? "";
    finalized = {
      ...finalized,
      error: `${target}${CONCEALED_FAILURE_MESSAGE}`,
    };
  }
  // A thrown agent-loop exit carries its stop reason on the error. It
  // describes this failure only: a success a hook produced gets none.
  const thrownStop = stopOf(options.cause, result.runId);
  if (finalized.status === "failed" && thrownStop)
    finalized = { ...finalized, stop: thrownStop };
  // Derive this after hooks and stop attribution; provider errorKind also
  // classifies ordinary plugin exceptions and cannot establish ownership.
  const { fault: _untrustedFault, ...withoutFault } = finalized;
  finalized = withoutFault;
  const serviceFailure = serviceFailureOf(options.cause);
  const ownServiceMisuse =
    serviceFailure?.callerPluginId === manifest.pluginId &&
    (serviceFailure.errorCode === "invalid-options" ||
      serviceFailure.errorCode === "cycle-or-depth-limit");
  // The caller's own deadline can cancel an outstanding service with the same
  // error object. That remains its timeout, regardless of service provenance.
  const ownDeadline =
    options.cause instanceof RuntimeTimeoutError ||
    finalized.stop?.reason === "deadline";
  if (
    finalized.status === "failed" &&
    !isSetupRuntime(manifest) &&
    !signal?.aborted &&
    (!serviceFailure || ownServiceMisuse || ownDeadline)
  ) {
    const stop = finalized.stop?.reason;
    if (stop === "deadline") finalized = { ...finalized, fault: "timeout" };
    else if (stop !== "cancelled" && stop !== "model-error") {
      if (
        stop === "max-steps" ||
        stop === "invalid-output" ||
        stop === "loop-detected" ||
        stop === "context-overflow"
      )
        finalized = { ...finalized, fault: "runtime" };
      else if (
        !providerThrown &&
        !finalized.failureTarget &&
        !finalized.error?.startsWith("[provider:")
      ) {
        if (options.cause instanceof RuntimeTimeoutError)
          finalized = { ...finalized, fault: "timeout" };
        else if (options.cause !== undefined)
          finalized = { ...finalized, fault: "runtime" };
      }
    }
  }
  await reportRuntimeResult(deps, input.sessionId, finalized);
  return finalized;
}
