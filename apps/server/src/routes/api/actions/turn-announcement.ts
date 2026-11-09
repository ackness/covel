/**
 * Turn phase 5, after the session lock is released: announce a settled turn.
 *
 * Job announcements and the final SSE writes deliberately run AFTER the
 * session lock releases: a slow client draining execution.completed must
 * not extend the critical section. The turn is settled by now, so none of
 * these steps may turn it into a failure; one that fails only asks the
 * client to resync.
 */

import type { TurnOutcome } from "./request-ledger.js";
import type { CommittedTurn } from "./turn-commit.js";
import type { TurnPhase } from "./turn-request.js";

export async function announceSettledTurn(
  phase: TurnPhase,
  locked: CommittedTurn,
): Promise<TurnOutcome> {
  const { request, stream, ledger, turn: turnArgs } = phase;
  const { host } = request;
  const { type } = request.body;
  const {
    result,
    trace,
    committed,
    commitError,
    fanOutFailed,
    wasPreGamePending,
    replaysPlayerInput,
    queuedRuntimeJobs,
    followerJobs,
  } = locked;
  // A request that completes the LAST setup runtime commits on its own
  // (turn-wide transaction discipline), so the narrator never ran for it:
  // the opening continuation follows. Guarded to player actions: a
  // `retry_turn` that replays the player's recorded answer continues as
  // its submission would have, while runtime retries and a retried opening
  // keep rerun-only semantics. Skipped when the turn aborted. Until it
  // starts, a stop reaches this request and the opening does not start;
  // otherwise a stop from here on has nothing to stop.
  const continues =
    turnArgs.origin === "player" &&
    committed &&
    wasPreGamePending &&
    !result.abortReason &&
    !request.isRuntimeRetry &&
    (type !== "retry_turn" || replaysPlayerInput);

  await ledger.afterSettlement("announcing deferred jobs", () =>
    host.announceDeferredJobs(queuedRuntimeJobs, (payload) =>
      stream.write("runtime.deferred", payload),
    ),
  );
  await ledger.afterSettlement("announcing queued jobs", async () =>
    host.announceQueuedJobs(followerJobs),
  );
  // Emit runtime progress: complete + persist trace
  await ledger.afterSettlement("recording turn.completed", () =>
    trace.turnCompleted(
      {
        durationMs: result.durationMs,
        resultCount: result.runtimeResults.length,
        committed,
        ...(result.abortReason ? { abortReason: result.abortReason } : {}),
      },
      stream.retryScope,
    ),
  );

  const settled: TurnOutcome = {
    stopReason: locked.stopReason,
    resultCount: result.runtimeResults.length,
    durationMs: result.durationMs,
    ...(result.abortReason ? { abortReason: result.abortReason } : {}),
    committed,
    ...(commitError ? { commitError } : {}),
    fanOutFailed,
    continues,
  };
  ledger.recordSettled(settled);
  await ledger.reportRound(settled);
  return settled;
}
