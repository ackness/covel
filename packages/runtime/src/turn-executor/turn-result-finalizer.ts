import type {
  ExecutionContext,
  InteractionPayload,
  PendingInputInfo,
  RuntimeResult,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import { buildRuntimeOutputFromResult } from "./turn-runtime-helpers.js";
import { toLegacyOrigin } from "./execution-context.js";
import type { TurnExecutorDeps } from "./turn-executor-types.js";

export interface FinalizeTurnResultParams {
  readonly input: TurnInput;
  /** Run identity created at `executeTurn` entry; owns the normalized origin. */
  readonly executionContext: ExecutionContext;
  readonly startTime: number;
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  readonly deferredFollowers: NonNullable<TurnResult["deferredFollowers"]>;
  readonly deps: TurnExecutorDeps;
  readonly turnNumber: number;
  /**
   *  results bubbled up from nested `ctx.recursiveCall` executions.
   * Carried on the TurnResult for the commit-owning caller; NOT re-persisted
   * here (nested executeTurn calls persist their own turn_results rows).
   */
  readonly nestedRuntimeResults?: readonly RuntimeResult[];
}

function collectPendingInputs(
  completedResults: ReadonlyMap<string, RuntimeResult>,
): PendingInputInfo[] {
  const pendingInputs: PendingInputInfo[] = [];
  for (const [, result] of completedResults) {
    if (!result.output) continue;
    const out = result.output as Record<string, unknown>;
    const interactions = out.interactions as
      Array<Record<string, unknown>> | undefined;
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
  executionContext: ExecutionContext,
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
        err,
      );
    }
  }

  await deps.store.saveTurnResult({
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    runtimeResults: turnResult.runtimeResults,
    // Stamp the execution origin so turn accounting can exclude
    // non-player executions (manual RPC / background follower / recursive)
    // from `session.turnCount`, which drives UI turn display and the
    // auto-snapshot cadence. Projected back to the legacy label so the
    // persisted column stays byte-identical (`background` → `follower`).
    origin: toLegacyOrigin(executionContext.origin),
    ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
    // Written before the commit runs, so it starts `pending`. The
    // commit-owning caller settles it — a row left `pending` is a crash, not
    // a successful turn, and previously the two were indistinguishable.
    commitStatus: "pending" as const,
    durationMs: turnResult.durationMs,
    createdAt: turnResult.timestamp ?? now,
  });
}

export async function finalizeTurnResult({
  input,
  executionContext,
  startTime,
  completedResults,
  deferredFollowers,
  deps,
  turnNumber,
  nestedRuntimeResults,
}: FinalizeTurnResultParams): Promise<TurnResult> {
  const pendingInputs = collectPendingInputs(completedResults);
  const turnResult: TurnResult = {
    turnId: input.turnId,
    sessionId: input.sessionId,
    runtimeResults: [...completedResults.values()],
    executionContext,
    ...(nestedRuntimeResults && nestedRuntimeResults.length > 0
      ? { nestedRuntimeResults }
      : {}),
    pendingInputs: pendingInputs.length > 0 ? pendingInputs : undefined,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    ...(deferredFollowers.length > 0 ? { deferredFollowers } : {}),
  };
  await persistTurnResult(
    turnResult,
    deps,
    input,
    turnNumber,
    executionContext,
  );

  // NOTE: `turn.completed` is intentionally NOT emitted here. The persisted
  // runtime results above are execution artefacts, not committed game state —
  // the authoritative completion event fires via `TurnResult.completeTurn`,
  // which the commit-owning caller invokes once proposals commit (a failed
  // auto-snapshot does not withhold it). A persisted result without a
  // completion event is the expected crash signature, tolerated by recovery.

  return turnResult;
}
