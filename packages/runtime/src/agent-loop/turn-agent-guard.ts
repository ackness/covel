import type {
  ExecutionContext,
  InputSlot,
  RuntimeActivation,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
  NestedTurnResult,
  RecursiveCallDelta,
} from "@covel/shared";
import {
  attachExecutionJournal,
  attachRuntimeTrigger,
} from "../execution-journal.js";
import { getRuntimeSpec, stageMessageOrder } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import { getToolContent, getPendingProposals } from "@covel/tools";
import type { HookPipeline } from "../hooks/pipeline.js";
import { createExecutionWriteBuffer } from "../function-runtime/execution-write-buffer.js";
import { createPluginRuntimeContext } from "../function-runtime/plugin-runtime-context.js";
import { attachNestedResults } from "../turn-executor/nested-results.js";
import { finalizeRuntimeResult } from "../turn-executor/runtime-finalization.js";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import { runLeasedInvocation } from "../turn-executor/runtime-scaffold.js";
import { freezeInputSlots } from "./runtime-input-slots.js";
import { deepFreeze } from "../hooks/hook-settings.js";

export interface ExecuteAgentGuardOptions {
  readonly lastPlayerInput?:
    import("@covel/shared").PlayerInputSubmission | null;
  readonly logicalTurn?: number;
  readonly upstreamProposals?: readonly import("@covel/shared").Proposal[];
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly loaded: LoadedRuntime;
  readonly deps: TurnExecutorDeps;
  readonly hookPipeline: HookPipeline | undefined;
  readonly triggerEvent:
    | {
        readonly topic: string;
        readonly data: Readonly<Record<string, unknown>>;
      }
    | undefined;
  /** The run's frozen activation, input bindings and exports. */
  readonly activation?: RuntimeActivation;
  readonly inputs?: Readonly<Record<string, InputSlot>>;
  readonly exports?: Readonly<Record<string, InputSlot>>;
  readonly executionContext: ExecutionContext;
  readonly executionId?: string;
  readonly createRecursiveCall: (
    parentSignal?: AbortSignal,
  ) => (
    delta: RecursiveCallDelta,
    opts?: { readonly reason?: string },
  ) => Promise<NestedTurnResult>;
  readonly recursionDepth: number;
  readonly startTime: number;
  readonly runId: string;
  /**
   * Total-duration hard cap for the guard call (`manifest.timeoutMs` ??
   * executor default) — same contract as the function-runtime handler
   * deadline in `turn-function-runtime.ts`.
   */
  readonly timeoutMs: number;
}

/**
 * Run an agent runtime's guard. The guard receives the same context as a
 * function handler (`createPluginRuntimeContext`), under the same deadline,
 * abort and revocation rules; its writes commit only when it skips the run.
 */
export async function executeAgentGuard({
  lastPlayerInput = null,
  logicalTurn,
  upstreamProposals = [],
  manifest,
  input,
  loaded,
  deps,
  hookPipeline,
  triggerEvent,
  activation,
  inputs,
  exports,
  executionContext,
  executionId,
  createRecursiveCall,
  recursionDepth,
  startTime,
  runId,
  timeoutMs,
}: ExecuteAgentGuardOptions): Promise<RuntimeResult | undefined> {
  if (loaded.guard) {
    const guard = loaded.guard;
    // Writes collect here and commit with the execution when the guard skips.
    const writeBuffer = createExecutionWriteBuffer();
    const runtimeContext = await createPluginRuntimeContext({
      manifest,
      input,
      loaded,
      deps,
      hookPipeline,
      triggerEvent,
      lastPlayerInput,
      ...(logicalTurn !== undefined ? { logicalTurn } : {}),
      upstreamProposals,
      // Own frozen copies: the agent reads the same bindings after the guard.
      ...(activation
        ? { activation: deepFreeze(structuredClone(activation)) }
        : {}),
      ...(inputs ? { inputs: freezeInputSlots(inputs) } : {}),
      ...(exports ? { exports: freezeInputSlots(exports) } : {}),
      executionContext,
      createRecursiveCall,
      recursionDepth,
      startTime,
      timeoutMs,
      ...(executionId !== undefined ? { executionId } : {}),
      writeBuffer,
    });

    // Deadline race — the same lease as a function handler: without it a hung
    // guard blocks the whole turn (and the session lock) forever. A guard's
    // capabilities are a lease for this invocation.
    const rawGuardOutput = await runLeasedInvocation(
      runtimeContext,
      () => guard(runtimeContext.context),
      {
        timeoutMs,
        timeoutMessage: `agent guard "${manifest.name}" timed out after ${timeoutMs}ms`,
        abortedMessage: `agent guard "${manifest.name}" aborted`,
        completedMessage: `agent guard "${manifest.name}" completed`,
      },
    );

    const guardOutput = getToolContent(rawGuardOutput);
    if (guardOutput.skip === true) {
      const pendingProposals = [
        ...getPendingProposals(rawGuardOutput),
        ...writeBuffer,
      ];

      // Record `skipped` in the internal RuntimeResult so downstream
      // consumers (Pre-Game completion tracker, session-kernel's
      // `result.status !== 'success'` gate, SSE payload) all see the same
      // story. Earlier code set `status: 'success'` here and only reported
      // 'skipped' in the outgoing SSE, which made the Pre-Game tracker's
      // `guardSkipped = result.status === 'skipped'` check dead code.
      const result: RuntimeResult = {
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
        runId,
        turnId: input.turnId,
        status: "skipped",
        output: guardOutput,
        ...(pendingProposals.length > 0 ? { pendingProposals } : {}),
        // Events from ctx.tools commit only with a successful run, as for a
        // function handler; the calls are still recorded.
        toolCalls: runtimeContext.tools.records,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };

      const postResult = await finalizeRuntimeResult(
        { ...deps, hookPipeline },
        manifest,
        input,
        result,
        { outputContractSchema: loaded.outputContractSchema },
      );
      // The guard's nested calls commit with its buffered writes: only when
      // it skipped the run and the result is still skipped. A hook that
      // changes the status drops the buffered writes (`wire-helpers.ts`), and
      // a guard that lets the agent run discards both.
      if (postResult.status === "skipped")
        attachNestedResults(postResult, runtimeContext.nestedResults);
      const postOutput = postResult.output as Record<string, unknown> | null;
      if (
        deps.store &&
        postResult.status === "skipped" &&
        typeof postOutput?.narrativeOutput === "string" &&
        postOutput.narrativeOutput
      ) {
        attachRuntimeTrigger(postResult, manifest.name);
        attachExecutionJournal(postResult, [
          {
            id: crypto.randomUUID(),
            sessionId: input.sessionId,
            turnId: input.turnId,
            sourceType: "runtime",
            sourcePluginId: manifest.pluginId,
            sourceRuntimeId: manifest.name,
            role: "assistant",
            name: manifest.name,
            content: postOutput.narrativeOutput,
            order: stageMessageOrder(getRuntimeSpec(manifest).stage),
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      return postResult;
    }
  }
  return undefined;
}
