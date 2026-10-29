import { settleAgentLoop } from "../agent-loop/settle-agent-loop.js";
import { loadLastPlayerInput } from "../turn-executor/session-state.js";
import { reportRuntimeStarted } from "../trace/runtime-telemetry.js";
import { DEFAULT_MAX_TOOL_STEPS } from "../agent-loop/agent-loop-policy.js";
import type {
  ExecutionContext,
  LLMTargetIdentity,
  Proposal,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
  TurnInput,
} from "@covel/shared";
import type { SuspensionRecord } from "@covel/store";
import type { EmittedEvent } from "@covel/tools";
import type { LLMMessage } from "@covel/shared";
import { runAgentToolLoop } from "../agent-loop/turn-agent-tool-loop.js";
import { createSubagentRunner } from "../agent-loop/subagent-runner.js";
import { withSubagentDelegate } from "../agent-loop/subagent-delegate.js";
import { freezeInputSlots } from "../agent-loop/runtime-input-slots.js";
import { executeFunctionRuntime } from "../function-runtime/turn-function-runtime.js";
import { createWorldModelView } from "../function-runtime/world-model-view.js";
import {
  finalizeRuntimeResult,
  runRuntimePreHook,
} from "../turn-executor/runtime-finalization.js";
import {
  DEFAULT_RUNTIME_TIMEOUT_MS,
  finalizeRuntimeFailure,
  finalizeThrownRuntime,
} from "../turn-executor/runtime-scaffold.js";
import { throwIfTurnExecutionAborted } from "../turn-executor/turn-control.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";

export interface ResumeSuspendedRuntimeOptions {
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly userSettings?: TurnInput["userSettings"];
  /**
   * The session's live `runtimeModelOverrides`. The resumed runtime and the
   * sub-agents it delegates to resolve their slots through it, as in a turn.
   */
  readonly runtimeModelOverrides?: TurnInput["runtimeModelOverrides"];
  /**
   * The session's active runtimes. A resumed setup runtime that completes is
   * checked against them to decide whether setup is finished. Defaults to the
   * resumed runtime alone.
   */
  readonly activeRuntimes?: readonly RuntimeManifest[];
}

/**
 * Re-enter the LLM tool loop for a suspended runtime.
 *
 * This is the resume third of the "suspend / resume / normal-execution" trio.
 * It rebuilds the mid-turn state from the persisted suspension and re-enters the
 * **shared** agent tool loop (`runAgentToolLoop`) with that state seeded in, then
 * settles through the **shared** `settleAgentLoop`. It no longer hand-rolls
 * its own copy of the loop / finalize blocks: resume now goes through the
 * same `requestLLMResponse` + retry / loop-detection / streaming machinery as the
 * main loop, so `maxRetries` / `firstTokenTimeoutMs` / `loopDetectionThreshold`
 * apply on resume too.
 *
 * The caller is responsible for auth, runtime lookup, and concurrency checks.
 */
export async function resumeRuntimePipeline(
  suspension: SuspensionRecord,
  resumeData: unknown,
  manifest: RuntimeManifest,
  deps: TurnExecutorDeps,
  options?: ResumeSuspendedRuntimeOptions,
): Promise<RuntimeResult> {
  const startTime = Date.now();
  const runId = crypto.randomUUID();

  // TurnInput for the resumed runtime: session, turn and content locale come
  // from the suspension and there is no fresh player message. The session's
  // runtime model overrides apply as in a turn; there is no request-scoped
  // story override on resume.
  const { locale } = suspension.pendingContinuation;
  const input: TurnInput = {
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    playerMessage: "",
    origin: "resume",
    ...(locale !== undefined ? { locale } : {}),
    ...(options?.userSettings ? { userSettings: options.userSettings } : {}),
    ...(options?.runtimeModelOverrides
      ? { runtimeModelOverrides: options.runtimeModelOverrides }
      : {}),
  };

  // A resumed runtime runs outside `runTurnPipeline`; it gets its own
  // sub-agent runner over the session's runtimes.
  if (!deps.subagents && options?.activeRuntimes)
    deps = {
      ...deps,
      subagents: createSubagentRunner({
        activeRuntimes: options.activeRuntimes,
      }),
    };
  try {
    return await executeResumedRuntime(suspension, resumeData, manifest, deps, {
      startTime,
      runId,
      input,
      options,
    });
  } catch (error: unknown) {
    // Unlike dispatch: plain `deps`, not the dispatcher's `{ ...deps, hookPipeline }`.
    return finalizeThrownRuntime(
      deps,
      { manifest, input, runId, startTime },
      error,
    );
  }
}

async function executeResumedRuntime(
  suspension: SuspensionRecord,
  resumeData: unknown,
  manifest: RuntimeManifest,
  deps: TurnExecutorDeps,
  execution: {
    readonly startTime: number;
    readonly runId: string;
    readonly input: TurnInput;
    readonly options?: ResumeSuspendedRuntimeOptions;
  },
): Promise<RuntimeResult> {
  const { startTime, runId, input, options } = execution;
  const maxSteps = options?.maxSteps ?? DEFAULT_MAX_TOOL_STEPS;
  // Resume lets the caller's timeout beat the manifest's, the reverse
  // of `resolveRuntimeTimeoutMs` for a dispatched runtime.
  const resumeTimeoutMs =
    options?.timeoutMs ?? manifest.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  const hookPipeline = deps.hookPipeline;
  let lastTarget: LLMTargetIdentity | undefined;
  let deltaCount = 0;

  const postRuntimeOptions = () => ({
    lastTarget,
    deltaCount,
    outputContractSchema: loaded?.outputContractSchema,
    ...(loaded?.outputSchema ? { agentOutputSchema: loaded.outputSchema } : {}),
  });
  const finalizeWithPostRuntime = (
    result: RuntimeResult,
  ): Promise<RuntimeResult> =>
    finalizeRuntimeResult(deps, manifest, input, result, postRuntimeOptions());

  const preRuntime = await runRuntimePreHook(
    deps,
    manifest,
    input,
    runId,
    startTime,
  );
  if (preRuntime) return preRuntime;

  const loaded = await deps.loadRuntime(
    manifest,
    input.locale,
    suspension.sessionId,
  );
  throwIfTurnExecutionAborted(deps.turnControl, "resume loading");
  if (!loaded) {
    return finalizeRuntimeFailure(
      deps,
      { manifest, input, runId, startTime },
      "Runtime not found on resume",
      postRuntimeOptions(),
    );
  }

  const { pendingContinuation } = suspension;
  const inherited = pendingContinuation.executionContext;
  const resumeExecutionContext: ExecutionContext = {
    ...inherited,
    executionId: runId,
    origin: "resume",
  };
  if (manifest.runtimeType === "function") {
    // Function continuations are deterministic handler invocations, not LLM
    // conversations. Feed resume data through the explicit handler context and
    // reuse the normal function finalizer so output normalization, hooks and
    // buffered proposals follow the same path as an ordinary invocation.
    const lastPlayerInput = await loadLastPlayerInput(
      deps.store,
      input.sessionId,
    );
    return executeFunctionRuntime({
      lastPlayerInput,
      ...(pendingContinuation.logicalTurn !== undefined
        ? { logicalTurn: pendingContinuation.logicalTurn }
        : {}),
      manifest,
      input,
      loaded,
      deps,
      hookPipeline,
      triggerEvent: undefined,
      inputs: pendingContinuation.inputSlots,
      exports: pendingContinuation.exportSlots,
      activation: pendingContinuation.activation,
      pendingProposals: pendingContinuation.pendingProposals as Proposal[],
      executionContext: resumeExecutionContext,
      createRecursiveCall: () => async () => {
        throw new Error(
          `function runtime "${manifest.name}" cannot use recursiveCall while resuming`,
        );
      },
      recursionDepth: 0,
      startTime,
      runId,
      timeoutMs: resumeTimeoutMs,
      executionId: runId,
      resumeData,
      resumedFromSuspensionId: suspension.id,
      allowSuspend: false,
    });
  }

  await reportRuntimeStarted(deps, input.sessionId, manifest, {
    turnId: input.turnId,
    runId,
  });

  // Rebuild the mid-turn transcript from the suspension and append the resume
  // payload: a tool result for the suspend tool (agent runtimes) or a user
  // message (function-runtime suspensions with no suspend tool call id).
  const messages: LLMMessage[] = [
    ...(pendingContinuation.messages as LLMMessage[]),
  ];
  // The transcript is still the suspended turn's: the budget keeps as much
  // of it as it did before the suspension.
  let currentTurnUserMessages =
    pendingContinuation.currentTurnUserMessages ?? 1;
  if (pendingContinuation.suspendToolCallId) {
    const resumedToolResult: LLMMessage = {
      role: "tool",
      content: JSON.stringify({ resumeData }),
      toolCallId: pendingContinuation.suspendToolCallId,
    };
    // The placeholder is the last result under this ID: an endpoint that
    // repeats an ID across the steps of a loop must not get an earlier
    // step's result rewritten.
    const placeholderIndex = messages
      .map(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === pendingContinuation.suspendToolCallId,
      )
      .lastIndexOf(true);
    if (placeholderIndex >= 0) {
      messages[placeholderIndex] = resumedToolResult;
    } else {
      throw new Error(
        `Invalid suspension continuation: missing tool placeholder ${pendingContinuation.suspendToolCallId}`,
      );
    }
  } else {
    messages.push({
      role: "user",
      content:
        typeof resumeData === "string"
          ? resumeData
          : JSON.stringify(resumeData),
    });
    currentTurnUserMessages += 1;
  }

  // The World Model base is what is committed now, as it is for a resumed
  // function runtime; the loop overlays the continuation's own buffered writes.
  const worldBase = deps.store
    ? await createWorldModelView(
        deps.worldModelReads ?? deps.store,
        input.sessionId,
        [],
        [],
        () => {},
        deps.dimensionContext,
      )
    : undefined;

  // Re-enter the shared agent tool loop with the persisted write set seeded in.
  // `allowSuspend: false` forbids re-suspending mid-resume (a nested suspend is
  // fed back to the LLM as an error tool result).
  // `delegate` runs a sub-agent; the wrapper answers it and forwards the rest.
  const loopDeps =
    deps.subagents && deps.toolExecutor
      ? {
          ...deps,
          toolExecutor: withSubagentDelegate(
            deps.toolExecutor,
            deps.subagents,
            {
              caller: {
                pluginId: manifest.pluginId,
                runtimeId: manifest.name,
                depth: 0,
              },
              input,
              deps,
              executionContext: resumeExecutionContext,
            },
          ),
        }
      : deps;
  const toolLoop = await runAgentToolLoop({
    worldBase,
    manifest,
    input,
    ...(pendingContinuation.turnNumber !== undefined
      ? { turnNumber: pendingContinuation.turnNumber }
      : {}),
    ...(pendingContinuation.logicalTurn !== undefined
      ? { logicalTurn: pendingContinuation.logicalTurn }
      : {}),
    loaded,
    inputSlots: pendingContinuation.inputSlots
      ? freezeInputSlots(pendingContinuation.inputSlots)
      : undefined,
    deps: loopDeps,
    maxSteps,
    timeoutMs: resumeTimeoutMs,
    messages,
    ...(deps.estimator && deps.contextBudget
      ? {
          estimator: deps.estimator,
          contextBudget: deps.contextBudget,
          currentTurnUserMessages,
        }
      : {}),
    hookPipeline,
    startTime,
    runId,
    executionContext: resumeExecutionContext,
    allowSuspend: false,
    initialState: {
      finalContent: pendingContinuation.partialContent ?? null,
      collectedToolCalls:
        pendingContinuation.toolCallsSoFar as ToolCallRecord[],
      completionCalls: pendingContinuation.completionCalls,
      pendingProposals: pendingContinuation.pendingProposals as Proposal[],
      emittedEvents:
        (pendingContinuation.emittedEvents as EmittedEvent[] | undefined) ?? [],
    },
  });
  // With allowSuspend:false the loop never suspends, so it cannot return a
  // terminal RuntimeResult (handleSuspension is unreachable); the guard keeps
  // the union types honest.
  if ("status" in toolLoop) return toolLoop;
  lastTarget = toolLoop.lastTarget;
  deltaCount = toolLoop.streamDeltaCount;

  const settled = settleAgentLoop({
    manifest,
    input,
    runId,
    startTime,
    toolLoop,
    outputSchema: loaded.outputSchema,
    priorToolCalls: pendingContinuation.toolCallsSoFar as ToolCallRecord[],
  });
  // The runtime NO LONGER resolves the suspension or appends the
  // assistant turn message here. Those writes belong to the commit-owning
  // caller (apps/server resume route), which folds them into the SAME
  // transaction as the proposal commit — resolving before commit meant a
  // commit failure left the suspension permanently resolved and the
  // narrative already in prompt history. The `turn.resumed` event moves
  // with them (it must not announce a resume that then rolls back).
  // PostRuntime runs BEFORE any persistence — the caller persists
  // the hook-finalized output.
  return finalizeWithPostRuntime(settled.result);
}
