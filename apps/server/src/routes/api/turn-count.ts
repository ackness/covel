import type { RuntimeManifest } from "@covel/shared";
import { getRuntimeSpec, mirrorSetupCompleted } from "@covel/shared";
import type { DataStore, SessionRecord, TurnResultRecord } from "@covel/store";
import { isPreGamePriority } from "@covel/runtime";

/**
 * Whether the session is still in the setup (Pre-Game) band.
 *
 * Reads the persisted `phase` — the scheduling-redesign source of truth.
 * Sessions written before `phase` existed are backfilled at the turn entry
 * (see {@link ensureSessionClockBackfilled}), so the legacy fallback below only
 * serves the pre-backfill instant / stores that bypass the backfill: any active
 * setup runtime not yet recorded in `preGameCompleted`.
 *
 * The actions route captures this BEFORE executing the turn, because the
 * execution itself may complete setup and a post-hoc read could no longer tell
 * a setup request from a main-loop turn.
 */
export function isPreGamePending(
  session: Pick<SessionRecord, "phase" | "preGameCompleted">,
  activeRuntimes: readonly RuntimeManifest[],
): boolean {
  if (session.phase !== undefined) return session.phase === "setup";
  const done = session.preGameCompleted ?? [];
  return activeRuntimes.some(
    (runtime) =>
      isPreGamePriority(getRuntimeSpec(runtime).legacyOrder) &&
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
 * Consulted ONLY at the `turnCount === 1` boundary during the one-time legacy
 * backfill (see {@link ensureSessionClockBackfilled}), where "1" is ambiguous:
 * it is either the Pre-Game floor placeholder (setup finished, no main-loop
 * turn taken yet ⇒ `completedPlayerTurns` should backfill to 0) or a genuinely
 * completed first turn (⇒ backfill to 1). The rows that exist at that boundary
 * are the handful of setup-phase executions, so the scan is bounded and it runs
 * at most once per legacy session.
 *
 * A prior row counts as a completed main-loop player turn when it is
 * player-origin (absent origin = legacy row = player), its commit did not fail
 * (absent commitStatus = legacy row = committed), and it either carries at least
 * one non-Pre-Game runtime result or is empty.
 */
export async function hasCompletedMainLoopTurnBefore(args: {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly preGameCompleted: readonly string[] | undefined;
}): Promise<boolean> {
  const { store, sessionId, activeRuntimes, preGameCompleted } = args;
  const preGameRuntimeIds = new Set<string>(preGameCompleted ?? []);
  for (const runtime of activeRuntimes) {
    if (isPreGamePriority(getRuntimeSpec(runtime).legacyOrder)) {
      preGameRuntimeIds.add(runtime.name);
    }
  }

  const turnResults = await store.listTurnResults(sessionId);
  return turnResults.some((turnResult) => {
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
 * Lazily backfill the scheduling-redesign clock fields on a legacy session.
 *
 * Sessions written before `phase` / `completedPlayerTurns` / `setupRuntimes`
 * existed carry only `turnCount` / `preGameCompleted`. The first turn entry that
 * touches such a session derives the new fields from the legacy ones — WITHOUT
 * ever parsing turnIds or scanning child turn_results beyond the bounded
 * `turnCount === 1` disambiguation — persists them, and stamps a migration note.
 * Idempotent: a session that already has `phase` is returned untouched.
 *
 * Mapping (see 04-migration.md §3):
 *  - `turnCount === 0`  → `completedPlayerTurns = 0`; `phase = setup` when an
 *    active setup runtime is still unresolved, else `playing`.
 *  - `turnCount > 1`    → `phase = playing`; `completedPlayerTurns = turnCount`.
 *  - `turnCount === 1`  → `phase = playing`; `completedPlayerTurns = 1` when a
 *    main-loop turn already completed, else `0` (the Pre-Game floor).
 */
export async function ensureSessionClockBackfilled(args: {
  readonly store: DataStore;
  readonly session: SessionRecord;
  readonly activeRuntimes: readonly RuntimeManifest[];
}): Promise<SessionRecord> {
  const { store, session, activeRuntimes } = args;
  if (session.phase !== undefined) return session;

  const legacyTurnCount = session.turnCount;
  const preGameCompleted = session.preGameCompleted ?? [];

  let phase: "setup" | "playing";
  let completedPlayerTurns: number;
  if (legacyTurnCount === 0) {
    const setupPending = activeRuntimes.some(
      (rt) =>
        isPreGamePriority(getRuntimeSpec(rt).legacyOrder) &&
        !preGameCompleted.includes(rt.name),
    );
    phase = setupPending ? "setup" : "playing";
    completedPlayerTurns = 0;
  } else if (legacyTurnCount > 1) {
    phase = "playing";
    completedPlayerTurns = legacyTurnCount;
  } else {
    phase = "playing";
    completedPlayerTurns = (await hasCompletedMainLoopTurnBefore({
      store,
      sessionId: session.id,
      activeRuntimes,
      preGameCompleted,
    }))
      ? 1
      : 0;
  }

  const setupRuntimes = mirrorSetupCompleted(
    preGameCompleted,
    session.updatedAt,
  );

  const patch = {
    phase,
    completedPlayerTurns,
    setupRuntimes,
    metadata: {
      ...session.metadata,
      runtimeMigration: {
        ...(session.metadata?.runtimeMigration as
          Record<string, unknown> | undefined),
        clock: { source: "legacy-backfill", legacyTurnCount },
      },
    },
    updatedAt: new Date().toISOString(),
  };
  await store.updateSession(session.id, patch);
  return { ...session, ...patch };
}
