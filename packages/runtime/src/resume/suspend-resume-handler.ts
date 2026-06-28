/**
 * Suspend handling for the agent tool-call loop.
 *
 * When a tool returns the suspend sentinel, the loop must capture its full
 * mid-turn state (messages, partial content, collected tool calls, buffered
 * proposals) into a {@link SuspensionRecord}, emit the `turn.suspended` /
 * `runtime.completed` events, run the PostRuntime hook, and exit with a
 * `status: "suspended"` RuntimeResult. Extracted verbatim from
 * `turn-agent-tool-loop.ts` so the main loop stays focused on iteration.
 */

import type {
  Proposal,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
  TurnInput,
} from "@covel/shared";
import type { SuspensionRecord } from "@covel/store";
import type { SuspendSentinel } from "@covel/tools";
import type { LLMMessage } from "../llm/llm-adapter.js";
import type { HookPipeline } from "../hooks/pipeline.js";
import { runPostRuntimeHook } from "../hooks/wire-helpers.js";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";

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
  readonly suspendToolCallId: string;
  readonly startTime: number;
  readonly runId: string;
}

/**
 * Persist a suspension record and return the terminal `suspended` RuntimeResult
 * (after the PostRuntime hook). The caller must have already confirmed
 * `deps.store` is present.
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
    suspendToolCallId,
    startTime,
    runId,
  } = opts;

  const suspensionId = crypto.randomUUID();

  // Messages array currently has the assistant message (with tool_calls)
  // but not the suspend tool result. We capture the full message
  // array together with any buffered proposals so resume can
  // continue with the same mid-turn write set.
  const pendingContinuation: SuspensionRecord["pendingContinuation"] = {
    messages: [...messages],
    partialContent: finalContent ?? undefined,
    toolCallsSoFar: [...collectedToolCalls],
    pendingProposals: [...pendingProposals],
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

  await deps.store!.saveSuspension(suspension);

  // Emit turn.suspended SSE event via the actions channel.
  // Include pluginId/runtimeId/suspendedAt so web clients can
  // render a suspension row without a follow-up REST fetch
  // (F4 web suspend/resume integration).
  emitSubEvent(deps.eventBus, "game", "turn.suspended", input.sessionId, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    suspensionId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    suspendedAt: suspension.createdAt,
    reason: sentinel.reason,
    resumeSchema: sentinel.resumeSchema,
  });

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

  try {
    await deps.onRuntimeComplete?.({
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      status: "suspended",
      durationMs: suspendedResult.durationMs,
    });
  } catch {
    /* callback error must not kill runtime */
  }

  emitSubEvent(deps.eventBus, "runtime", "runtime.completed", input.sessionId, {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    status: "suspended",
    durationMs: suspendedResult.durationMs,
  });

  return runPostRuntimeHook(
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
  );
}
