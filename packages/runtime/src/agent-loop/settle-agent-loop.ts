import type {
  LoopStop,
  RuntimeManifest,
  RuntimeResult,
  ToolCallRecord,
  TurnInput,
} from "@covel/shared";
import { makeFailedResult } from "../turn-executor/turn-executor-helpers.js";
import { formatToolLoopFailure } from "../turn-executor/turn-output-helpers.js";
import { finalizeAgentOutput } from "./finalize-agent-output.js";
import { completionContractError } from "./runtime-completion.js";
import { createAgentSchemaGate } from "./runtime-output-validator.js";
import type { AgentToolLoopCompleted } from "./turn-agent-tool-loop.js";

/** Settle ordinary and resumed loops before their caller runs hooks and telemetry. */
export function settleAgentLoop(args: {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly runId: string;
  readonly startTime: number;
  readonly toolLoop: AgentToolLoopCompleted;
  readonly outputSchema?: Record<string, unknown>;
  readonly priorToolCalls?: readonly ToolCallRecord[];
}): { readonly kind: "failed" | "success"; readonly result: RuntimeResult } {
  const {
    manifest,
    input,
    runId,
    startTime,
    toolLoop,
    outputSchema,
    priorToolCalls,
  } = args;
  const {
    finalContent,
    finalToolOutput,
    collectedToolCalls,
    executedToolCalls,
    failedToolCalls,
    pendingProposals,
    emittedEvents,
    stop,
    effectiveMaxSteps,
  } = toolLoop;
  const fail = (error: string, failedStop: LoopStop = stop) => ({
    kind: "failed" as const,
    result: {
      ...makeFailedResult(manifest, input, runId, startTime, error, {
        toolCalls: collectedToolCalls,
      }),
      stop: failedStop,
    },
  });
  // A step limit or a deadline is never a success by itself, whatever text
  // the model wrote beside its tool calls. Only a finalizer that produced the
  // answer turns a step limit into a completion.
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
      return fail(
        formatToolLoopFailure({
          runtimeId: manifest.name,
          reason: "timeout",
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
    default:
      break;
  }
  // Required tool work cannot succeed just because the model returned prose.
  const completionError = completionContractError(manifest, toolLoop);
  if (completionError) return fail(completionError);

  const finalized = finalizeAgentOutput({
    manifest,
    finalContent,
    ...(finalToolOutput ? { preferredOutput: finalToolOutput } : {}),
    executedToolCalls,
    priorToolCalls,
    failedToolCalls,
    pendingProposals,
    emittedEvents,
    dedupeInteractions: true,
    schemaGate: createAgentSchemaGate({
      manifest,
      input,
      runId,
      startTime,
      collectedToolCalls,
      outputSchema,
    }),
  });
  if (finalized.kind === "tool-failed") {
    return fail(
      formatToolLoopFailure({
        runtimeId: manifest.name,
        reason: "tool_failed_without_output",
        failedToolCalls,
      }),
    );
  }
  // The output gate failed, not the loop.
  if (finalized.kind === "invalid-output")
    return fail(finalized.error, { reason: "invalid-output" });
  if (finalized.kind === "short-circuit")
    return {
      kind: "failed",
      result: { ...finalized.result, stop: { reason: "invalid-output" } },
    };
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
