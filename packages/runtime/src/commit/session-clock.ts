/**
 * Session-clock write, folded into the finalize transaction.
 *
 * Single mutation point (with the legacy backfill) for a session's
 * `phase` / `completedPlayerTurns` / `setupRuntimes`. It runs INSIDE
 * `finalizeExecution`'s transaction, after every proposal has committed, so a
 * proposal failure rolls back the counter, the phase flip, and the setup mirror
 * together with the domain writes — the clock never advances for a turn that
 * did not commit.
 *
 * Two concerns are applied here:
 *  1. Logical-turn counting — an idempotent ledger insert per `logicalTurnId`
 *     increments `completedPlayerTurns` at most once, even if the same logical
 *     turn is finalized twice (retry / duplicate).
 *  2. Setup completion — newly-done setup runtimes are mirrored onto
 *     `setupRuntimes` and, when that resolves the last one, the band flips
 *     `setup → playing`.
 *
 * The legacy `turnCount` / `preGameCompleted` fields are re-derived from the
 * resulting clock via the shared formula and written in the same patch.
 */

import type { StoreTransaction } from "@covel/store";
import type {
  ExecutionContext,
  SetupRuntimeState,
  SessionClock,
} from "@covel/shared";
import { deriveLegacyClockFields } from "@covel/shared";

export interface SetupCompletionDelta {
  readonly newlyDone: Readonly<Record<string, SetupRuntimeState>>;
  readonly allSetupDone: boolean;
}

export interface SessionClockUpdate {
  readonly now: string;
  readonly setupCompletion?: SetupCompletionDelta;
}

/**
 * Whether an execution touches the session clock at all. Skips the session read
 * for executions that neither count a player turn nor observe setup completion
 * (manual RPC / background follower / recursive with no setup delta).
 */
export function needsSessionClockWrite(
  executionContext: ExecutionContext | undefined,
  update: SessionClockUpdate | undefined,
): boolean {
  return (
    executionContext?.countPolicy === "complete-player-turn" ||
    update?.setupCompletion !== undefined
  );
}

export async function applySessionClockTx(
  tx: StoreTransaction,
  args: {
    readonly sessionId: string;
    readonly executionContext?: ExecutionContext;
    readonly update: SessionClockUpdate;
  },
): Promise<void> {
  const { sessionId, executionContext, update } = args;
  const session = await tx.getSession(sessionId);
  if (!session) return;

  // A session reaching finalize has been backfilled at the turn entry, so
  // `phase` is set. Defensive default: infer from what this execution carries.
  const currentPhase: "setup" | "playing" =
    session.phase ?? (update.setupCompletion ? "setup" : "playing");
  let completedPlayerTurns = session.completedPlayerTurns ?? 0;

  // (1) Logical-turn counting — idempotent per logicalTurnId.
  if (
    executionContext?.countPolicy === "complete-player-turn" &&
    executionContext.logicalTurnId
  ) {
    const inserted = await tx.insertLogicalTurnCompletion({
      sessionId,
      logicalTurnId: executionContext.logicalTurnId,
      completedByExecutionId: executionContext.executionId,
      completedAt: update.now,
    });
    if (inserted) completedPlayerTurns += 1;
  }

  // (2) Setup mirror + band flip.
  const setupRuntimes: Record<string, SetupRuntimeState> = {
    ...(session.setupRuntimes ?? {}),
    ...(update.setupCompletion?.newlyDone ?? {}),
  };
  const phase: "setup" | "playing" =
    currentPhase === "setup" && update.setupCompletion?.allSetupDone
      ? "playing"
      : currentPhase;

  const clock: SessionClock = { phase, completedPlayerTurns, setupRuntimes };
  const legacy = deriveLegacyClockFields(clock);

  await tx.updateSession(sessionId, {
    phase,
    completedPlayerTurns,
    setupRuntimes,
    turnCount: legacy.turnCount,
    preGameCompleted: legacy.preGameCompleted,
    updatedAt: update.now,
  });
}
