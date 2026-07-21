import type { RuntimeManifest } from "@covel/shared";
import type { DataStore, TurnResultRecord } from "@covel/store";

/**
 * Whether any Pre-Game runtime (priority band 0–99) has not yet reported done
 * for this session. While pending, the session is still in the Pre-Game band:
 * player requests iterate on setup and do NOT advance `turnCount` — the 0 → 1
 * transition is written atomically with the final `preGameCompleted` entry by
 * the turn executor (packages/runtime/src/turn-executor/pre-game-completion.ts).
 *
 * The actions route captures this BEFORE executing the turn (from the session
 * read under the lock), because the execution itself may complete Pre-Game and
 * a post-hoc read could no longer tell a setup request from a main-loop turn.
 */
export function isPreGamePending(
  activeRuntimes: readonly RuntimeManifest[],
  preGameCompleted: readonly string[] | undefined,
): boolean {
  const done = preGameCompleted ?? [];
  return activeRuntimes.some(
    (runtime) =>
      runtime.priority !== undefined &&
      runtime.priority <= 99 &&
      !done.includes(runtime.name),
  );
}

function runtimeResultsOf(
  turnResult: TurnResultRecord,
): readonly { readonly runtimeId?: unknown }[] {
  return Array.isArray(turnResult.runtimeResults)
    ? (turnResult.runtimeResults as readonly { readonly runtimeId?: unknown }[])
    : [];
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

/**
 * Whether a main-loop player turn already completed BEFORE the current one.
 *
 * Only consulted at the `turnCount === 1` boundary (see below), where "1" is
 * ambiguous: it is either the Pre-Game floor placeholder (setup finished, no
 * main-loop turn taken yet — the current turn IS turn 1 and must not
 * increment) or a genuinely completed first turn (the current turn is turn 2).
 * The rows that exist at that boundary are the handful of setup-phase
 * executions, so the scan is bounded; every later turn skips it entirely.
 *
 * A prior row counts as a completed main-loop player turn when it is
 * player-origin (absent origin = legacy row = player), its commit did not
 * fail (absent commitStatus = legacy row = committed), and it either carries
 * at least one non-Pre-Game runtime result or is empty (a main-loop turn
 * where the player advanced but no runtime fired still counts — see the
 * "counts main-loop turns even when no runtime fires" pipeline test).
 */
async function hasCompletedMainLoopTurnBefore(args: {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly currentTurnId: string;
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly preGameCompleted: readonly string[] | undefined;
}): Promise<boolean> {
  const { store, sessionId, currentTurnId, activeRuntimes, preGameCompleted } =
    args;
  const preGameRuntimeIds = new Set<string>(preGameCompleted ?? []);
  for (const runtime of activeRuntimes) {
    if (runtime.priority !== undefined && runtime.priority <= 99) {
      preGameRuntimeIds.add(runtime.name);
    }
  }

  const turnResults = await store.listTurnResults(sessionId);
  return turnResults.some((turnResult) => {
    if (turnResult.turnId === currentTurnId) return false;
    if (turnResult.origin && turnResult.origin !== "player") return false;
    if (
      turnResult.commitStatus === "failed" ||
      turnResult.commitStatus === "pending"
    ) {
      return false;
    }
    const results = runtimeResultsOf(turnResult);
    return (
      results.length === 0 ||
      results.some(
        (result) => !isPreGameRuntimeResult(result, preGameRuntimeIds),
      )
    );
  });
}

/**
 * Advance `session.turnCount` by one completed player turn.
 *
 * Called by the actions route under the session lock, after every proposal of
 * the turn has been committed and the execution artifact's `commitStatus` has
 * been settled. The counter is monotonic and incremental: it moves forward
 * from whatever the session already records (0 at creation, 1 from the
 * Pre-Game completion write, or an inherited value on a session forked from a
 * snapshot) instead of being recomputed from turn_results history. That makes
 * the steady-state update O(1) — the previous implementation re-listed and
 * re-deserialized every turn_results row of the session on every turn — and
 * it cannot clobber a forked session's restored count (forks copy `turnCount`
 * but not the parent's turn_results rows, so a full recount collapsed the
 * count back to 1).
 *
 * The one boundary needing history is `turnCount === 1`: when Pre-Game
 * finished without running any main-loop runtime, the "1" is a floor
 * placeholder and the first real main-loop turn absorbs it (it IS turn 1);
 * when a main-loop turn already completed under that count, the current turn
 * is turn 2. See {@link hasCompletedMainLoopTurnBefore}.
 *
 * No-op when:
 *  - `committed` is false — a turn whose proposals failed to commit (or whose
 *    execution crashed) is not a completed player turn. Non-player executions
 *    (manual plugin-rpc triggers, deferred followers, nested recursiveCall)
 *    never reach this function: their routes do not call it.
 *  - Pre-Game was still pending when the turn started — setup requests do not
 *    count, and the request that finishes setup is already accounted for by
 *    the atomic `turnCount: 1` write in pre-game-completion.
 *  - The session is missing or no longer active.
 */
export async function advanceSessionTurnCount(args: {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly turnId: string;
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly wasPreGamePending: boolean;
  readonly committed: boolean;
}): Promise<void> {
  const {
    store,
    sessionId,
    turnId,
    activeRuntimes,
    wasPreGamePending,
    committed,
  } = args;
  if (!committed || wasPreGamePending) return;

  const session = await store.getSession(sessionId);
  if (!session || session.status !== "active") return;

  if (
    session.turnCount === 1 &&
    !(await hasCompletedMainLoopTurnBefore({
      store,
      sessionId,
      currentTurnId: turnId,
      activeRuntimes,
      preGameCompleted: session.preGameCompleted,
    }))
  ) {
    // Absorb the Pre-Game floor: this turn is turn 1 and the counter already
    // says so.
    return;
  }

  await store.updateSession(sessionId, {
    turnCount: session.turnCount + 1,
    updatedAt: new Date().toISOString(),
  });
}
