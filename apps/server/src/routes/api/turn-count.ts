import type { RuntimeManifest } from "@covel/shared";
import type { DataStore, TurnResultRecord } from "@covel/store";

function runtimeResultsOf(
  turnResult: TurnResultRecord,
): readonly { readonly runtimeId?: unknown }[] {
  return Array.isArray(turnResult.runtimeResults)
    ? (turnResult.runtimeResults as readonly { readonly runtimeId?: unknown }[])
    : [];
}

function hasMainLoopRuntimeResult(
  turnResult: TurnResultRecord,
  preGameRuntimeIds: ReadonlySet<string>,
): boolean {
  return runtimeResultsOf(turnResult).some(
    (result) => !isPreGameRuntimeResult(result, preGameRuntimeIds),
  );
}

function isPreGameRuntimeResult(
  result: { readonly runtimeId?: unknown; readonly output?: unknown },
  preGameRuntimeIds: ReadonlySet<string>,
): boolean {
  if (
    typeof result.runtimeId === "string" &&
    preGameRuntimeIds.has(result.runtimeId)
  ) {
    return true;
  }

  const output =
    result.output && typeof result.output === "object"
      ? (result.output as Readonly<Record<string, unknown>>)
      : undefined;
  return output?.preGameDone === true;
}

export async function computeSessionTurnCount(args: {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly activeRuntimes: readonly RuntimeManifest[];
}): Promise<number> {
  const { store, sessionId, activeRuntimes } = args;
  const session = await store.getSession(sessionId);
  if (!session || session.status !== "active") {
    return session?.turnCount ?? 0;
  }

  const preGameRuntimeIds = new Set<string>(session.preGameCompleted ?? []);
  for (const runtime of activeRuntimes) {
    if (runtime.priority !== undefined && runtime.priority <= 99) {
      preGameRuntimeIds.add(runtime.name);
    }
  }

  const preGamePending = activeRuntimes.some(
    (runtime) =>
      runtime.priority !== undefined &&
      runtime.priority <= 99 &&
      !(session.preGameCompleted ?? []).includes(runtime.name),
  );
  if (preGamePending) {
    return session.turnCount;
  }

  const turnResults = await store.listTurnResults(sessionId);
  // Counting rule (Pre-Game-pending turns never reach here — early-returned above):
  //  - Only `player`-origin executions count. Manual plugin-rpc
  //    triggers, deferred background followers, and nested recursiveCall
  //    executions each persist their own turn_results row but are NOT player
  //    turns; counting them inflated `session.turnCount`, which drives the UI
  //    turn display, auto-snapshot cadence, and snapshot numbering. Rows
  //    written before the `origin` column existed have no origin and are
  //    treated as `player` (backward compatible).
  //  - Distinct logical turns only: several executions may share one turnId
  //    (e.g. a Pre-Game completion request that also runs main-loop
  //    followups), and that is ONE player turn.
  //  - An EMPTY turn_result counts. It represents a main-loop player turn where
  //    the player advanced but no runtime fired; the player still took a turn.
  //    (2026-04-12 audit Finding 3 — see turn-commit-pipeline.test.ts
  //    "counts main-loop turns even when no runtime fires". This is intentional;
  //    do not "optimise" it away.)
  //  - A NON-EMPTY turn_result counts only when it carries at least one
  //    non-Pre-Game runtime result, so Pre-Game-only setup requests are excluded.
  const countedTurnIds = new Set<string>();
  for (const turnResult of turnResults) {
    if (turnResult.origin && turnResult.origin !== "player") continue;
    const runtimeResults = runtimeResultsOf(turnResult);
    const counts =
      runtimeResults.length === 0 ||
      hasMainLoopRuntimeResult(turnResult, preGameRuntimeIds);
    if (counts) countedTurnIds.add(turnResult.turnId);
  }
  const mainLoopResultCount = countedTurnIds.size;

  const preGameFloor = preGameRuntimeIds.size > 0 ? 1 : 0;
  return Math.max(preGameFloor, mainLoopResultCount);
}

export async function syncSessionTurnCount(args: {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly activeRuntimes: readonly RuntimeManifest[];
}): Promise<void> {
  const { store, sessionId, activeRuntimes } = args;
  const nextTurnCount = await computeSessionTurnCount({
    store,
    sessionId,
    activeRuntimes,
  });
  const session = await store.getSession(sessionId);
  if (!session || session.turnCount === nextTurnCount) return;

  await store.updateSession(sessionId, {
    turnCount: nextTurnCount,
    updatedAt: new Date().toISOString(),
  });
}
