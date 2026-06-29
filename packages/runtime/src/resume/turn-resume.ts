import type {
  Proposal,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
  TurnInput,
} from "@covel/shared";
import type { SuspensionRecord } from "@covel/store";
import type { LLMMessage } from "../llm/llm-adapter.js";
import {
  runPostRuntimeHook,
  runPreRuntimeHook,
} from "../hooks/wire-helpers.js";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import { formatToolLoopFailure } from "../turn-executor/turn-output-helpers.js";
import { runAgentToolLoop } from "../agent-loop/turn-agent-tool-loop.js";
import { finalizeAgentOutput } from "../agent-loop/finalize-agent-output.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";

export interface ResumeSuspendedRuntimeOptions {
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
}

/**
 * Re-enter the LLM tool loop for a suspended runtime.
 *
 * This is the resume third of the "suspend / resume / normal-execution" trio.
 * It rebuilds the mid-turn state from the persisted suspension and re-enters the
 * **shared** agent tool loop (`runAgentToolLoop`) with that state seeded in, then
 * finalizes through the **shared** `finalizeAgentOutput`. It no longer hand-rolls
 * its own copy of the loop / finalize blocks (F1.b): resume now goes through the
 * same `requestLLMResponse` + retry / loop-detection / streaming machinery as the
 * main loop, so `maxRetries` / `firstTokenTimeoutMs` / `loopDetectionThreshold`
 * apply on resume too.
 *
 * The caller is responsible for auth, runtime lookup, and concurrency checks.
 */
export async function resumeSuspendedRuntime(
  suspension: SuspensionRecord,
  resumeData: unknown,
  manifest: RuntimeManifest,
  deps: TurnExecutorDeps,
  options?: ResumeSuspendedRuntimeOptions,
): Promise<RuntimeResult> {
  const startTime = Date.now();
  const maxSteps = options?.maxSteps ?? 10;
  const timeoutMs = options?.timeoutMs ?? manifest.timeoutMs ?? 60000;
  const runId = crypto.randomUUID();
  const hookPipeline = deps.hookPipeline;

  // Minimal TurnInput for the resumed runtime: session/turn come from the
  // suspension and there is no fresh player message. With no model overrides the
  // loop resolves the model via `deps.resolveModel(manifest, undefined)`, which
  // matches the pre-refactor resume behaviour.
  const input: TurnInput = {
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    playerMessage: "",
  };

  const postRuntimeOpts = {
    pipeline: hookPipeline,
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    eventBus: deps.eventBus,
    emitter: deps.emitter,
  };
  const finalizeWithPostRuntime = (
    result: RuntimeResult,
  ): RuntimeResult | Promise<RuntimeResult> =>
    hookPipeline ? runPostRuntimeHook(postRuntimeOpts, result) : result;

  // ── PreRuntime hook ──────────────────────────────────────────────
  if (hookPipeline) {
    const preRtResult = await runPreRuntimeHook({
      pipeline: hookPipeline,
      sessionId: suspension.sessionId,
      turnId: suspension.turnId,
      manifest,
      input,
      eventBus: deps.eventBus,
      emitter: deps.emitter,
    });
    if (preRtResult.action === "abort") {
      return finalizeWithPostRuntime({
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        runId,
        turnId: suspension.turnId,
        status: "skipped",
        output: null,
        toolCalls: [],
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });
    }
  }

  const loaded = await deps.loadRuntime(manifest, undefined);
  if (!loaded) {
    return finalizeWithPostRuntime({
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: suspension.turnId,
      status: "failed",
      output: null,
      toolCalls: [],
      durationMs: Date.now() - startTime,
      error: "Runtime not found on resume",
      timestamp: new Date().toISOString(),
    });
  }

  // Rebuild the mid-turn transcript from the suspension and append the resume
  // payload: a tool result for the suspend tool (agent runtimes) or a user
  // message (function-runtime suspensions with no suspend tool call id).
  const { pendingContinuation } = suspension;
  const messages: LLMMessage[] = [
    ...(pendingContinuation.messages as LLMMessage[]),
  ];
  if (pendingContinuation.suspendToolCallId) {
    messages.push({
      role: "tool",
      content: JSON.stringify({ resumeData }),
      toolCallId: pendingContinuation.suspendToolCallId,
    });
  } else {
    messages.push({
      role: "user",
      content:
        typeof resumeData === "string"
          ? resumeData
          : JSON.stringify(resumeData),
    });
  }

  // Re-enter the shared agent tool loop with the persisted write set seeded in.
  // `allowSuspend: false` forbids re-suspending mid-resume (a nested suspend is
  // fed back to the LLM as an error tool result).
  const toolLoop = await runAgentToolLoop({
    manifest,
    input,
    loaded,
    deps,
    maxSteps,
    timeoutMs,
    messages,
    hookPipeline,
    startTime,
    runId,
    allowSuspend: false,
    initialState: {
      finalContent: pendingContinuation.partialContent ?? null,
      collectedToolCalls:
        pendingContinuation.toolCallsSoFar as ToolCallRecord[],
      pendingProposals: pendingContinuation.pendingProposals as Proposal[],
    },
  });
  // With allowSuspend:false the loop never suspends, so it cannot return a
  // terminal RuntimeResult (handleSuspension is unreachable); the guard keeps
  // the union types honest.
  if ("status" in toolLoop) return toolLoop;

  const {
    finalContent,
    collectedToolCalls,
    executedToolCalls,
    failedToolCalls,
    pendingProposals,
    stoppedWithResponse,
    effectiveMaxSteps,
    deadline,
  } = toolLoop;

  if (!stoppedWithResponse && !finalContent) {
    return finalizeWithPostRuntime({
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: suspension.turnId,
      status: "failed",
      output: null,
      toolCalls: collectedToolCalls,
      durationMs: Date.now() - startTime,
      error: formatToolLoopFailure({
        runtimeId: manifest.name,
        reason: Date.now() >= deadline ? "timeout" : "max_steps",
        maxSteps: effectiveMaxSteps,
        failedToolCalls,
      }),
      timestamp: new Date().toISOString(),
    });
  }

  const finalized = finalizeAgentOutput({
    manifest,
    finalContent,
    executedToolCalls,
    failedToolCalls,
    pendingProposals,
  });
  if (finalized.kind === "tool-failed") {
    return finalizeWithPostRuntime({
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: suspension.turnId,
      status: "failed",
      output: null,
      toolCalls: collectedToolCalls,
      durationMs: Date.now() - startTime,
      error: formatToolLoopFailure({
        runtimeId: manifest.name,
        reason: "tool_failed_without_output",
        failedToolCalls,
      }),
      timestamp: new Date().toISOString(),
    });
  }
  if (finalized.kind === "short-circuit") {
    // Unreachable: resume passes no schemaGate. Defensive only.
    return finalizeWithPostRuntime(finalized.result);
  }
  const output = finalized.output;

  if (deps.store) {
    await deps.store.markSuspensionResolved(suspension.id);
  }

  emitSubEvent(deps.eventBus, "game", "turn.resumed", suspension.sessionId, {
    sessionId: suspension.sessionId,
    turnId: suspension.turnId,
    suspensionId: suspension.id,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
  });

  return finalizeWithPostRuntime({
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: suspension.turnId,
    status: "success",
    output,
    toolCalls: collectedToolCalls,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  });
}
