/**
 * The turns of one action request and how the request ends.
 *
 * `runActionRequest` chains the player's turn, the opening continuation and
 * auto-advanced rounds, and reports `execution.completed`. When it throws,
 * `failActionRequest` settles the failed turn and reports the error on the
 * already-open stream. `releaseActionRequest` always runs last, before the
 * route closes the stream.
 */

import {
  abandonExecution,
  FormRejectedError,
  FormValidatorFailedError,
  InteractionSubmissionError,
} from "@covel/runtime";
import { PLAYER_ABORT_REASON, readRuntimeEnv } from "@covel/shared";
import { SESSION_BUSY_CODE, SESSION_BUSY_MESSAGE } from "../../../api-error.js";
import { SessionLockTimeoutError } from "../../../lib/session-lock.js";
import { listRuntimeJobs } from "../plugin-rpc/jobs.js";
import { ActionRejectedError } from "./action-rejection.js";
import type { ActionStream } from "./action-stream.js";
import { runAutoAdvance } from "./auto-advance.js";
import {
  STOPPED_OUTCOME,
  type RequestLedger,
  type TurnOutcome,
} from "./request-ledger.js";
import { runTurnOnce } from "./run-turn.js";
import type { ActionTurnRequest } from "./turn-request.js";

export async function runActionRequest(
  request: ActionTurnRequest,
  stream: ActionStream,
  ledger: RequestLedger,
): Promise<void> {
  const { store, host, isRuntimeRetry } = request;
  const { type, sessionId, payload } = request.body;
  const { control, root } = ledger;
  // A settlement an earlier turn left pending would refuse this turn:
  // try it again first, as the player would from the notice.
  if (!isRuntimeRetry)
    await host.retryPendingDimensionSettlements(control.signal);
  const first = await runTurnOnce(request, stream, ledger, {
    turnId: request.turnId,
    suppressPlayerMessage: type === "start_session",
    origin: "player",
  });
  let finalRun = first;

  // Opening continuation: chain exactly one main-loop turn — a second
  // transaction reading the just-committed setup state — so the player
  // gets the opening narrative without having to send another message.
  // Skipped when setup is still pending (more setup interactions to come).
  if (first.continues) {
    // The setup turn is saved either way: a failed read skips the
    // opening, and the player's next message starts the story.
    const live = await store.getSession(sessionId).catch((error) => {
      console.warn(
        `[actions] reading ${sessionId} before the opening failed:`,
        error,
      );
      return null;
    });
    if (live && live.status === "active" && live.phase === "playing") {
      finalRun = await runTurnOnce(request, stream, ledger, {
        turnId: crypto.randomUUID(),
        suppressPlayerMessage: true,
        origin: "continuation",
      });
    }
  }
  const advanced = await runAutoAdvance({
    root,
    control,
    first: finalRun,
    enabled:
      !isRuntimeRetry &&
      type !== "retry_turn" &&
      payload.recoverFromTurnId === undefined,
    publish: ledger.publishAdvance,
    run: async () => {
      const outcome = await runTurnOnce(request, stream, ledger, {
        turnId: crypto.randomUUID(),
        suppressPlayerMessage: true,
        origin: "continuation",
        generated: true,
      });
      return outcome.notStarted
        ? {
            stopped:
              ledger.autoStartRefusal ?? control.stopReason ?? "player-stop",
          }
        : { outcome };
    },
  });
  finalRun = advanced.final;
  stream.enterTurn(ledger.lastActualTurnId);
  control.finish();
  await ledger.closeFaultGroup();
  await stream.write("execution.completed", {
    runtimeCount:
      ledger.lastSettled?.turnId === ledger.lastActualTurnId
        ? ledger.lastSettled.runtimeCount
        : ledger.activeRuntimes.length,
    resultCount: finalRun.resultCount,
    durationMs: finalRun.durationMs,
    committed: finalRun.committed,
    ...(finalRun.commitError ? { error: finalRun.commitError } : {}),
    // Committed, but the events of some of it were not published: read the
    // stored state instead of waiting for them.
    ...(ledger.resyncRequired || advanced.resync ? { resync: true } : {}),
    // Surface a turn that was aborted before producing output (e.g. a
    // TurnStart hook that refuses the turn, or the player stopping it
    // before it began) so the player gets a visible reason instead of a
    // silent empty turn.
    ...(finalRun.abortReason ? { abortReason: finalRun.abortReason } : {}),
  });
}

/** Settle and report a request that threw; the stream is already open. */
export async function failActionRequest(
  request: ActionTurnRequest,
  stream: ActionStream,
  ledger: RequestLedger,
  err: unknown,
): Promise<void> {
  const { store, host } = request;
  const { requestId, sessionId } = request.body;
  const { control, root } = ledger;
  const { traceId } = stream;
  const priorOutcome =
    !ledger.hasStartedTurn || ledger.lastSettled?.turnId === stream.turnId
      ? ledger.lastSettled
      : undefined;
  const failedOutcome: TurnOutcome = priorOutcome?.outcome ?? {
    ...STOPPED_OUTCOME,
    abortReason: control.signal.aborted ? PLAYER_ABORT_REASON : undefined,
    commitError: control.signal.aborted ? undefined : "Execution failed",
  };
  const message = err instanceof Error ? err.message : String(err);
  // A known failure must not leave the execution artifact `pending` —
  // that state is reserved for crashes. An execution that never reached
  // the commit is abandoned; without one in hand (execution threw, or the
  // commit threw before settling) the row alone settles, a no-op when the
  // turn persisted none. Best-effort, never throwing: the stream error
  // event below matters more than this bookkeeping write.
  if (ledger.hasStartedTurn && !ledger.commitStatusSettled) {
    ledger.markCommitSettled();
    const uncommittedExecution = ledger.uncommittedExecution;
    if (uncommittedExecution)
      await abandonExecution({ execution: uncommittedExecution, store });
    else
      await store
        .setTurnResultCommitStatus(sessionId, stream.turnId, "failed")
        .catch(() => {});
  }
  if (ledger.hasStartedTurn && !priorOutcome) {
    await store
      .addTraceEvent({
        id: crypto.randomUUID(),
        sessionId,
        turnId: stream.turnId,
        traceId,
        type: "turn.failed",
        payload: { error: message, requestId, ...stream.retryScope },
        createdAt: new Date().toISOString(),
      })
      .catch(() => {});
  }
  await ledger.reportRound(failedOutcome);
  if (ledger.requestStarted)
    await ledger.publishAdvance(
      root.stopped(
        control.stopReason ??
          (ledger.hasStartedTurn
            ? "execution-failed"
            : "prerequisite-unavailable"),
        ledger.lastActualTurnId,
      ),
    );
  // This stream is already open (HTTP 200), so the global error
  // handler's coded 503 mapping cannot apply — replicate its wire
  // semantics here. Raw error text can carry internals (the PG lock
  // timeout names the session id and lock-pool hints; store/driver
  // failures carry paths or SQL fragments), so a lost lock race goes out
  // as the same fixed message + `session_busy` code the JSON path uses,
  // and every other error only carries the raw message in dev. Full
  // detail stays in the server log and, for a started turn, in the
  // `turn.failed` trace event above.
  const lockBusy = err instanceof SessionLockTimeoutError;
  if (lockBusy) {
    console.warn(`[actions] session lock timeout for ${sessionId}: ${message}`);
  } else if (err instanceof ActionRejectedError) {
    // An expected refusal (stale retry, input already saved): no failure.
    console.warn(
      `[actions] action refused for ${sessionId}: ${err.code ?? "rejected"}`,
    );
  } else if (err instanceof FormValidatorFailedError) {
    // The client gets the fixed text; what the plugin threw stays here.
    host.logRequestError(
      `[actions] form validator failed for ${sessionId}`,
      err.cause,
    );
  } else {
    console.error(`[actions] turn failed for ${sessionId}: ${message}`, err);
  }
  const isDev = readRuntimeEnv().nodeEnv !== "production";
  await stream
    .write(
      "error.occurred",
      lockBusy
        ? { message: SESSION_BUSY_MESSAGE, code: SESSION_BUSY_CODE }
        : err instanceof ActionRejectedError
          ? { message: err.message, ...(err.code ? { code: err.code } : {}) }
          : err instanceof InteractionSubmissionError
            ? {
                // Written for the player (or names a malformed request):
                // nothing was stored and no turn started.
                message: err.message,
                code: err.code,
                ...(err instanceof FormRejectedError
                  ? { details: { issues: err.issues } }
                  : {}),
              }
            : { message: isDev ? message : "Internal server error" },
    )
    .catch(() => {});
  await ledger.closeFaultGroup();
  if (ledger.requestStarted)
    await stream.write("execution.completed", {
      runtimeCount: priorOutcome?.runtimeCount ?? ledger.activeRuntimes.length,
      resultCount: failedOutcome.resultCount,
      durationMs: failedOutcome.durationMs,
      committed: failedOutcome.committed,
      ...(ledger.resyncRequired ? { resync: true } : {}),
      ...(failedOutcome.abortReason
        ? { abortReason: failedOutcome.abortReason }
        : {}),
      ...(failedOutcome.commitError
        ? { error: failedOutcome.commitError }
        : {}),
    });
}

/**
 * Always last: no further turn of the request starts, its steer/abort target
 * is released, and credentials handed to jobs that did not stay queued are
 * discarded. The route then closes the stream.
 */
export async function releaseActionRequest(
  request: ActionTurnRequest,
  stream: ActionStream,
  ledger: RequestLedger,
): Promise<void> {
  const { store, host } = request;
  const { sessionId } = request.body;
  const { control } = ledger;
  control.finish();
  await ledger.closeFaultGroup();
  control.release();
  stream.stopForwarding();
  try {
    if (ledger.credentialKeys.length > 0) {
      const queuedIds = new Set(
        (await listRuntimeJobs(store, { sessionId, statuses: ["queued"] })).map(
          (job) => job.jobId,
        ),
      );
      for (const key of ledger.credentialKeys)
        if (!queuedIds.has(key.jobId)) host.jobCredentials?.discard(key);
    }
  } catch (error) {
    // A transient read failure must not leak the turn lock. Handoffs have a TTL.
    console.warn("[actions] credential handoff cleanup failed", error);
  }
}
