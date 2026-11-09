/**
 * One complete turn: lock → prepare → start → execute → commit, then the
 * post-lock announcement. The request runs it for the player's turn and again
 * for the opening continuation and each auto-advanced round, on the same
 * stream: each turn is its own transaction and lock tenure.
 */

import { ActionRejectedError } from "./action-rejection.js";
import type { ActionStream } from "./action-stream.js";
import {
  STOPPED_OUTCOME,
  type RequestLedger,
  type TurnOutcome,
} from "./request-ledger.js";
import { announceSettledTurn } from "./turn-announcement.js";
import { commitExecutedTurn, type CommittedTurn } from "./turn-commit.js";
import { executeStartedTurn } from "./turn-execution.js";
import { prepareLockedTurn } from "./turn-preparation.js";
import type {
  ActionTurnRequest,
  TurnArgs,
  TurnPhase,
  TurnStopped,
} from "./turn-request.js";
import { startPreparedTurn } from "./turn-start.js";

export async function runTurnOnce(
  request: ActionTurnRequest,
  stream: ActionStream,
  ledger: RequestLedger,
  turnArgs: TurnArgs,
): Promise<TurnOutcome> {
  const phase: TurnPhase = { request, stream, ledger, turn: turnArgs };
  const { host } = request;
  const { control } = ledger;
  if (!turnArgs.generated) stream.enterTurn(turnArgs.turnId);
  ledger.resetTurn();
  stream.setRetryScope(undefined);
  // Stopped before this turn took the lock: it does not start. A stopped
  // opening is still recorded, under the lock (no settle wait) so its
  // marker cannot be ordered behind another action's turn.
  const stopBeforeStart = async (): Promise<TurnOutcome> => {
    if (turnArgs.origin === "continuation" && !turnArgs.generated)
      await ledger.afterSettlement("recording the stopped opening", () =>
        host.withSessionLock(() =>
          ledger.recordStoppedContinuation(turnArgs.turnId),
        ),
      );
    return { ...STOPPED_OUTCOME, notStarted: true };
  };
  if (control.signal.aborted || (turnArgs.generated && !control.canAdvance))
    return stopBeforeStart();
  const executeCapturedTurn = async (): Promise<
    CommittedTurn | TurnStopped
  > => {
    host.workSignal?.throwIfAborted();
    try {
      const prepared = await prepareLockedTurn(phase);
      if (prepared.stopped) return prepared;
      const started = await startPreparedTurn(phase, prepared);
      if (started.stopped) return started;
      const execution = await executeStartedTurn(phase, prepared, started);
      return await commitExecutedTurn(phase, prepared, started, execution);
    } finally {
      // Torn down while the lock is still held: after release the next
      // action owns the session, and its events must not be wrapped in
      // this stream's turnId/traceId envelope.
      stream.stopForwarding();
    }
  };
  let locked: CommittedTurn | TurnStopped;
  try {
    locked = await host.withSettledLock(executeCapturedTurn, control.signal);
  } catch (error) {
    // The stop ended the wait for the lock or for earlier work to settle.
    if (control.signal.aborted && !ledger.hasStartedTurn)
      return stopBeforeStart();
    if (
      turnArgs.generated &&
      !ledger.hasStartedTurn &&
      error instanceof ActionRejectedError
    ) {
      ledger.refuseAutoStart("session-unavailable");
      return { ...STOPPED_OUTCOME, notStarted: true };
    }
    throw error;
  }
  if (locked.stopped) return { ...STOPPED_OUTCOME, notStarted: true };
  return announceSettledTurn(phase, locked);
}
