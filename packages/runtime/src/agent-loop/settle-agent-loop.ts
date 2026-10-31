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
import { schemaAsksForSegments } from "./story-output.js";
import type { AgentToolLoopCompleted } from "./turn-agent-tool-loop.js";

interface AgentOutputArgs {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly runId: string;
  readonly startTime: number;
  readonly toolLoop: Pick<
    AgentToolLoopCompleted,
    | "finalContent"
    | "finalToolOutput"
    | "executedToolCalls"
    | "failedToolCalls"
    | "pendingProposals"
    | "emittedEvents"
    | "collectedToolCalls"
  >;
  readonly outputSchema?: Record<string, unknown>;
  readonly priorToolCalls?: readonly ToolCallRecord[];
}

/** One output gate for settlement and the silent pre-settlement repair check. */
function evaluateAgentOutput(args: AgentOutputArgs, silent = false) {
  const {
    manifest,
    input,
    runId,
    startTime,
    toolLoop,
    outputSchema,
    priorToolCalls,
  } = args;
  let errors: readonly string[] = [];
  const finalized = finalizeAgentOutput({
    manifest,
    finalContent: toolLoop.finalContent,
    ...(toolLoop.finalToolOutput
      ? { preferredOutput: toolLoop.finalToolOutput }
      : {}),
    executedToolCalls: toolLoop.executedToolCalls,
    priorToolCalls,
    failedToolCalls: toolLoop.failedToolCalls,
    pendingProposals: toolLoop.pendingProposals,
    emittedEvents: toolLoop.emittedEvents,
    dedupeInteractions: true,
    silent,
    // Only the repair check is strict; settlement commits the lenient story.
    ...(silent
      ? {
          strictStory: {
            segmentsRequired: schemaAsksForSegments(outputSchema),
          },
        }
      : {}),
    schemaGate: createAgentSchemaGate({
      manifest,
      input,
      runId,
      startTime,
      collectedToolCalls: toolLoop.collectedToolCalls,
      outputSchema,
      onValidationErrors: (problems) => {
        errors = problems;
      },
    }),
  });
  if (finalized.kind === "invalid-output") errors = finalized.problems;
  return { finalized, errors };
}

/** Test the output gates only; tool failures and completion contracts settle separately. */
export function checkAgentOutput(
  args: AgentOutputArgs,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] } {
  const { finalized, errors } = evaluateAgentOutput(args, true);
  return finalized.kind === "invalid-output" ||
    finalized.kind === "short-circuit"
    ? { ok: false, errors }
    : { ok: true };
}

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
    default:
      break;
  }
  // Required tool work cannot succeed just because the model returned prose.
  const completionError = completionContractError(manifest, toolLoop);
  if (completionError) return fail(completionError);

  const { finalized } = evaluateAgentOutput(args);
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
