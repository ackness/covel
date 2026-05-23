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
  const mainLoopResultCount = turnResults.filter((turnResult) => {
    const runtimeResults = runtimeResultsOf(turnResult);
    if (runtimeResults.length === 0) return true;
    return hasMainLoopRuntimeResult(turnResult, preGameRuntimeIds);
  }).length;

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
