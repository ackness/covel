import type {
  LoopStop,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
} from "@covel/shared";
import { makeFailedResult } from "../turn-executor/turn-executor-helpers.js";
import { formatToolLoopFailure } from "../turn-executor/turn-output-helpers.js";
import { finalizeAgentOutput } from "./finalize-agent-output.js";
import { completionContractError } from "./runtime-completion.js";
import type { AgentToolLoopCompleted } from "./turn-agent-tool-loop.js";

/** Settle ordinary and resumed loops before their caller runs hooks and telemetry. */
export function settleAgentLoop(args: {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly runId: string;
  readonly startTime: number;
  readonly toolLoop: AgentToolLoopCompleted;
  readonly outputSchema?: Record<string, unknown>;
}): { readonly kind: "failed" | "success"; readonly result: RuntimeResult } {
  const { manifest, input, runId, startTime, toolLoop } = args;
  const { collectedToolCalls, failedToolCalls, stop, effectiveMaxSteps } =
    toolLoop;
  const fail = (error: string, failedStop: LoopStop = stop) => ({
    kind: "failed" as const,
    result: {
      ...makeFailedResult(manifest, input, runId, startTime, error, {
        toolCalls: collectedToolCalls,
      }),
      stop: failedStop,
    },
  });
  // Budget stops are never successes by themselves, whatever text the model
  // wrote beside its tool calls. Only a finalizer that produced the answer
  // turns a step limit, deadline reserve or context overflow into a completion.
  switch (stop.reason) {
    case "max-steps":
      if (stop.finalizer) break;
      return fail(
        formatToolLoopFailure({
          runtimeId: manifest.name,
          reason: "max_steps",
          maxSteps: effectiveMaxSteps,
          failedToolCalls,
        }),
      );
    case "deadline":
      if (stop.finalizer) break;
      return fail(
        formatToolLoopFailure({
          runtimeId: manifest.name,
          reason: "timeout",
          failedToolCalls,
        }),
      );
    case "context-overflow":
      if (stop.finalizer) break;
      return fail(
        formatToolLoopFailure({
          runtimeId: manifest.name,
          reason: "context_overflow",
          ...(toolLoop.stopMessage ? { message: toolLoop.stopMessage } : {}),
          failedToolCalls,
        }),
      );
    case "cancelled":
      if (stop.cancelledBy !== "hook") break;
      return fail(
        formatToolLoopFailure({
          runtimeId: manifest.name,
          reason: "stopped_by_hook",
          ...(toolLoop.stopMessage ? { message: toolLoop.stopMessage } : {}),
          failedToolCalls,
        }),
      );
    case "invalid-output":
      return fail(
        toolLoop.stopMessage ?? "Output submission was not accepted.",
      );
    case "model-error":
    case "loop-detected":
      return fail("Agent ended without an accepted submission.");
    default:
      break;
  }
  // Required tool work cannot succeed just because the model returned prose.
  const completionError = completionContractError(manifest, toolLoop);
  if (completionError) return fail(completionError);

  if (!toolLoop.acceptedOutput)
    return fail(
      toolLoop.stopMessage ??
        "Agent ended without an accepted submit-output call.",
      { reason: "invalid-output" },
    );
  const finalized = finalizeAgentOutput({
    manifest,
    acceptedOutput: toolLoop.acceptedOutput,
    executedToolCalls: toolLoop.executedToolCalls,
    pendingProposals: toolLoop.pendingProposals,
    emittedEvents: toolLoop.emittedEvents,
    dedupeInteractions: true,
  });
  if (finalized.kind === "invalid-output")
    return fail(finalized.error, { reason: "invalid-output" });
  return {
    kind: "success",
    result: {
      pluginId: manifest.pluginId,
      runtimeId: manifest.name,
      runId,
      turnId: input.turnId,
      status: "success",
      output: finalized.output,
      ...(finalized.pendingProposals
        ? { pendingProposals: finalized.pendingProposals }
        : {}),
      ...(finalized.effects ? { effects: finalized.effects } : {}),
      ...(finalized.completion ? { completion: finalized.completion } : {}),
      toolCalls: collectedToolCalls,
      durationMs: Date.now() - startTime,
      stop,
      timestamp: new Date().toISOString(),
    },
  };
}
