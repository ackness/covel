/**
 * Turn phase 3, under the settled session lock: execute a started turn.
 *
 * Runtime starts and completions are recorded as traces and written to the
 * stream as they happen; story drafts stream through the stream's draft
 * delivery. The execution is held by the ledger until the commit takes it,
 * so a failure in between abandons it instead of leaving it pending.
 */

import { executeTurn, type ExecutedTurn } from "@covel/runtime";
import type { PreparedTurn } from "./turn-preparation.js";
import type { TurnPhase } from "./turn-request.js";
import type { StartedTurn } from "./turn-start.js";

export async function executeStartedTurn(
  phase: TurnPhase,
  prepared: PreparedTurn,
  started: StartedTurn,
): Promise<ExecutedTurn> {
  const { request, stream, ledger } = phase;
  const { store, eventBus, host } = request;
  const { activeRuntimes, turnControl, outputKindByRuntime } = prepared;
  const { trace, emitter, hookScope, turnInput } = started;
  // Execute turn through the API pipeline.
  //
  // Control covers preparation, execution and commit. Closing the SSE
  // transport does not cancel this turn; a refreshed client observes
  // it through the read-only execution endpoint until finalization.
  const execution = await executeTurn(turnInput, activeRuntimes, {
    ...host.executorDeps(),
    hookScope,
    // The main turn path never passed the eventBus, so every
    // `emitSubEvent` inside the executor — including the
    // completion barrier's `turn.completed` — silently no-opped on
    // the player-facing path (found while adding the
    // fault-injection tests). Without it the barrier's only
    // observable effect was memory ingestion.
    eventBus,
    store,
    emitter,
    outputDrafts: stream.outputDrafts,
    onRuntimeStart: async (info) => {
      try {
        await trace.runtimeStarted(info);
      } finally {
        const kind = outputKindByRuntime.get(info.runtimeId) ?? "system";
        await stream.write("runtime.started", {
          ...info,
          kind,
          label: info.pluginId + "/" + kind,
        });
      }
    },
    onRuntimeComplete: async (info) => {
      try {
        if (info.status === "failed") {
          await trace.runtimeFailed({
            ...info,
            error: info.error ?? "Runtime failed",
          });
        } else {
          await trace.runtimeCompleted(info);
        }
      } finally {
        const eventType =
          info.status === "failed"
            ? "runtime.failed"
            : info.status === "skipped"
              ? "runtime.skipped"
              : "runtime.completed";
        await stream.write(eventType, { ...info });
      }
    },
    // Player mid-turn steering + abort.
    turnControl,
  });
  ledger.holdExecution(execution);
  return execution;
}
