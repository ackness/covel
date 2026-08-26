/**
 * Suspend handling for the agent tool-call loop.
 *
 * When a tool returns the suspend sentinel, the loop must capture its full
 * mid-turn state (messages, partial content, collected tool calls, buffered
 * proposals) into an execution-local {@link SuspensionRecord} artifact, run
 * the PostRuntime hook, emit `runtime.completed`, and exit with a
 * `status: "suspended"` RuntimeResult. Extracted from
 * `turn-agent-tool-loop.ts` so the main loop stays focused on iteration.
 */

import type {
  Proposal,
  ExecutionContext,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
  TurnInput,
} from "@covel/shared";
import type { SuspensionRecord } from "@covel/store";
import type { EmittedEvent, SuspendSentinel } from "@covel/tools";
import type { LLMMessage } from "../llm/llm-adapter.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import { runPostRuntimeHook } from "../hooks/wire-helpers.js";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";
import { attachSuspensionArtifact } from "../suspension-artifact.js";

export interface HandleSuspensionOptions {
  readonly sentinel: SuspendSentinel;
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly deps: AgentLoopDeps;
  readonly hookPipeline: HookPipeline | undefined;
  readonly messages: readonly LLMMessage[];
  readonly finalContent: string | null;
  readonly collectedToolCalls: readonly ToolCallRecord[];
  readonly pendingProposals: readonly Proposal[];
  readonly emittedEvents: readonly EmittedEvent[];
  readonly executionContext: ExecutionContext;
  readonly suspendToolCallId: string;
  readonly startTime: number;
  readonly runId: string;
}

/**
 * Return the terminal `suspended` RuntimeResult with an execution-local
 * continuation artifact. Persistence belongs to `finalizeExecution`.
 */
export async function handleSuspension(
  opts: HandleSuspensionOptions,
): Promise<RuntimeResult> {
  const {
    sentinel,
    manifest,
    input,
    deps,
    hookPipeline,
    messages,
    finalContent,
    collectedToolCalls,
    pendingProposals,
    emittedEvents,
    executionContext,
    suspendToolCallId,
    startTime,
    runId,
  } = opts;

  const suspensionId = crypto.randomUUID();

  // Capture the provider-valid transcript (including a placeholder tool result
  // for the suspender and cancellation results for later calls in its batch)
  // together with buffered writes so resume can continue atomically.
  const pendingContinuation: SuspensionRecord["pendingContinuation"] = {
    messages: [...messages],
    partialContent: finalContent ?? undefined,
    toolCallsSoFar: [...collectedToolCalls],
    pendingProposals: [...pendingProposals],
    ...(emittedEvents.length > 0 ? { emittedEvents: [...emittedEvents] } : {}),
    executionContext,
    // Store the suspend tool's call ID so resume can append a proper tool result
    suspendToolCallId,
  };

  const suspension: SuspensionRecord = {
    id: suspensionId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    reason: sentinel.reason,
    resumeSchema: sentinel.resumeSchema,
    pendingContinuation,
    createdAt: new Date().toISOString(),
  };

  const suspendedResult: RuntimeResult = {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: input.turnId,
    status: "suspended",
    output: {
      suspended: true,
      suspensionId,
      reason: sentinel.reason,
      resumeSchema: sentinel.resumeSchema,
    },
    toolCalls: [...collectedToolCalls],
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  };

  const finalResult = attachSuspensionArtifact(
    await runPostRuntimeHook(
      {
        pipeline: hookPipeline,
        sessionId: input.sessionId,
        turnId: input.turnId,
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        eventBus: deps.eventBus,
        emitter: deps.emitter,
      },
      suspendedResult,
    ),
    { record: suspension },
  );

  try {
    await deps.onRuntimeComplete?.({
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      status: "suspended",
      durationMs: finalResult.durationMs,
    });
  } catch {
    /* callback error must not kill runtime */
  }

  emitSubEvent(deps.eventBus, "runtime", "runtime.completed", input.sessionId, {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    status: "suspended",
    durationMs: finalResult.durationMs,
  });
  return finalResult;
}
