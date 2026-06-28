import type {
  InteractionPayload,
  PendingInputInfo,
  RuntimeResult,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import {
  buildRuntimeOutputFromResult,
  emitSubEvent,
} from "./turn-runtime-helpers.js";
import type { TurnExecutorDeps } from "./turn-executor-types.js";

export interface FinalizeTurnResultParams {
  readonly input: TurnInput;
  readonly startTime: number;
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  readonly deferredFollowers: NonNullable<TurnResult["deferredFollowers"]>;
  readonly deps: TurnExecutorDeps;
  readonly turnNumber: number;
}

function collectPendingInputs(
  completedResults: ReadonlyMap<string, RuntimeResult>,
): PendingInputInfo[] {
  const pendingInputs: PendingInputInfo[] = [];
  for (const [, result] of completedResults) {
    if (!result.output) continue;
    const out = result.output as Record<string, unknown>;
    const interactions = out.interactions as
      | Array<Record<string, unknown>>
      | undefined;
    const narrativeFallback =
      typeof out.narrativeTemplate === "string"
        ? out.narrativeTemplate
        : typeof out.narrativeOutput === "string"
          ? out.narrativeOutput
          : "";

    if (interactions && interactions.length > 0) {
      for (const interaction of interactions) {
        pendingInputs.push({
          pluginId: result.pluginId,
          runtimeId: result.runtimeId,
          interaction: interaction as unknown as InteractionPayload,
          form:
            interaction.type === "form"
              ? (interaction as Record<string, unknown>)
              : undefined,
          narrativeTemplate:
            (interaction.narrativeTemplate as string) ?? narrativeFallback,
        });
      }
    }
  }
  return pendingInputs;
}

async function persistTurnResult(
  turnResult: TurnResult,
  deps: TurnExecutorDeps,
  input: TurnInput,
  turnNumber: number,
): Promise<void> {
  if (!deps.store) return;
  const now = new Date().toISOString();

  for (const rr of turnResult.runtimeResults) {
    await deps.store.saveRuntimeResult({
      id: rr.runId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      pluginId: rr.pluginId,
      runtimeId: rr.runtimeId,
      status: rr.status,
      output: rr.output,
      toolCalls: rr.toolCalls,
      durationMs: rr.durationMs,
      error: rr.error,
      createdAt: rr.timestamp ?? now,
    });

    try {
      await deps.store.saveRuntimeOutput(
        buildRuntimeOutputFromResult(rr, input.sessionId, turnNumber, now),
      );
    } catch (err) {
      console.warn(
        `[turn-executor] saveRuntimeOutput failed for ${rr.runtimeId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  await deps.store.saveTurnResult({
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    runtimeResults: turnResult.runtimeResults,
    durationMs: turnResult.durationMs,
    createdAt: turnResult.timestamp ?? now,
  });

  try {
    const { buildSnapshotPayload } =
      await import("../snapshot/snapshot-payload-builder.js");
    const payload = await buildSnapshotPayload(
      deps.store,
      input.sessionId,
      input.turnId,
    );
    const snapshotId = crypto.randomUUID();
    await deps.store.saveSnapshot({
      id: snapshotId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      kind: "auto",
      payload,
      createdAt: turnResult.timestamp ?? now,
    });
    emitSubEvent(
      deps.eventBus,
      "session",
      "state.snapshot.created",
      input.sessionId,
      {
        turnId: input.turnId,
        snapshotId,
        kind: "auto",
      },
    );
  } catch (err) {
    console.warn(
      `[turn-executor] auto snapshot failed for session ${input.sessionId} turn ${input.turnId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function finalizeTurnResult({
  input,
  startTime,
  completedResults,
  deferredFollowers,
  deps,
  turnNumber,
}: FinalizeTurnResultParams): Promise<TurnResult> {
  const pendingInputs = collectPendingInputs(completedResults);
  const turnResult: TurnResult = {
    turnId: input.turnId,
    sessionId: input.sessionId,
    runtimeResults: [...completedResults.values()],
    pendingInputs: pendingInputs.length > 0 ? pendingInputs : undefined,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    ...(deferredFollowers.length > 0 ? { deferredFollowers } : {}),
  };

  await persistTurnResult(turnResult, deps, input, turnNumber);

  emitSubEvent(deps.eventBus, "game", "turn.completed", input.sessionId, {
    turnId: input.turnId,
    sessionId: input.sessionId,
    durationMs: turnResult.durationMs,
  });

  return turnResult;
}
