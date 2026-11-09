/**
 * Turn phase 1, under the settled session lock: admit the turn against the
 * live session before anything of it is written.
 *
 * It re-reads the session, gates an auto-advanced round, resolves the turn's
 * origin and recovery, freezes the request's input clock, syncs the registry
 * from the live session, plans a runtime retry, checks the player's input and
 * any interaction answer, and makes this request the session's active turn.
 * A turn refused here never records `turn.started`.
 */

import {
  interactionSubmissionPayload,
  type PreparedInteractionSubmission,
  type TurnControl,
} from "@covel/runtime";
import type { RuntimeManifest, TurnAction } from "@covel/shared";
import type { SessionRecord } from "@covel/store";
import { ActionRejectedError, entryRejection } from "./action-rejection.js";
import {
  hasPendingAdvanceInput,
  readAdvanceProvenance,
  type AdvanceProvenance,
} from "./auto-advance.js";
import { assertRecoverableTurn } from "./execution-recovery.js";
import {
  actionContext,
  assertInputUncommitted,
  playerTurnInput,
  recordedPlayerInput,
  resolveActionsFor,
  type PlayerTurnInput,
} from "./player-input.js";
import { prepareRuntimeRetry, type RuntimeRetryPlan } from "./runtime-retry.js";
import { ActionValidationError } from "./submit-actions.js";
import type { TurnPhase, TurnStopped } from "./turn-request.js";

/** A turn admitted under the lock, not yet started. */
export interface PreparedTurn {
  readonly stopped: false;
  /** The session read under the lock. */
  readonly liveSession: SessionRecord;
  /** The flow `turn.started` records: a player turn or the opening. */
  readonly origin: "player" | "continuation";
  /** The provenance of the turn a recovery runs again. */
  readonly recovered: AdvanceProvenance | undefined;
  readonly resolvedActions: readonly TurnAction[] | undefined;
  readonly playerInput: PlayerTurnInput | undefined;
  /** An interaction answer, checked; stored with `turn.started`. */
  readonly submission: PreparedInteractionSubmission | undefined;
  readonly retryPlan: RuntimeRetryPlan | undefined;
  /** The runtimes active for this turn, from the live session. */
  readonly activeRuntimes: readonly RuntimeManifest[];
  /** Player steering and abort, with the server's execution signal. */
  readonly turnControl: TurnControl;
  /** The player's stop or the server's shutdown cancels the commit. */
  readonly commitSignal: AbortSignal;
  /** Progress display metadata, from the live manifests for this run. */
  readonly outputKindByRuntime: ReadonlyMap<string, string>;
}

export async function prepareLockedTurn(
  phase: TurnPhase,
): Promise<PreparedTurn | TurnStopped> {
  const { request, stream, ledger, turn: turnArgs } = phase;
  const { store, pluginRegistry, body, host } = request;
  const { type, sessionId, payload } = body;
  const { control, root } = ledger;
  let turnOrigin = turnArgs.origin;
  // Authoritative gate: re-read the session status under the
  // lock BEFORE any write. A pause/end that raced the pre-stream
  // check must not get player messages, interaction records, or
  // compaction appended to a non-active session. The throw surfaces
  // as an `error.occurred` SSE event via the request's failure path.
  const liveSession = await host.readLiveSession();
  if (turnArgs.generated) {
    if (!control.canAdvance) return { stopped: true as const };
    if (liveSession.phase !== "playing") {
      ledger.refuseAutoStart("session-unavailable");
      return { stopped: true as const };
    }
    if (await hasPendingAdvanceInput(store, sessionId)) {
      ledger.refuseAutoStart("pending-input");
      return { stopped: true as const };
    }
    const denied = await host.preflightActionApprovals(liveSession);
    if (denied) {
      ledger.refuseAutoStart("prerequisite-unavailable");
      const rejection = await entryRejection(denied);
      await stream.write("error.occurred", {
        message: rejection.message,
        code: rejection.code,
      });
      return { stopped: true as const };
    }
  }
  if (type === "start_session" && liveSession.phase === "playing")
    turnOrigin = "continuation";
  let recovered: AdvanceProvenance | undefined;
  if (turnArgs.origin !== "continuation") {
    const recovery = await assertRecoverableTurn(
      store,
      sessionId,
      payload.recoverFromTurnId,
      { type, payload },
    );
    turnOrigin = recovery?.origin ?? turnOrigin;
    recovered = await readAdvanceProvenance(
      store,
      sessionId,
      payload.recoverFromTurnId ??
        ("retryFromTurnId" in payload ? payload.retryFromTurnId : undefined),
    );
  }
  root.freeze(liveSession, recovered);
  ledger.openFaultGroup();
  // This execution now owns the session — events on the bus from here on
  // belong to this turn. The turn tears the forwarding down while it still
  // holds the lock.
  stream.forwardBusEvents();
  // The player's actions, checked against the live session. A
  // `retry_turn` of a turn that answered an interaction runs again
  // from the actions that turn recorded: the answer is stored.
  let resolvedActions: readonly TurnAction[] | undefined;
  if (turnArgs.generated) {
    const action = root.systemAction(liveSession);
    if (!action) {
      ledger.refuseAutoStart("session-unavailable");
      return { stopped: true as const };
    }
    resolvedActions = [action];
  } else if (recovered?.kind === "advance") {
    resolvedActions = recovered.actions;
  }
  let inputMessageId: string | undefined;
  const liveActionContext =
    turnOrigin === "player" &&
    (type === "submit_actions" || type === "retry_turn")
      ? await actionContext(store, pluginRegistry, liveSession)
      : undefined;
  if (
    liveActionContext &&
    turnOrigin === "player" &&
    type === "submit_actions"
  ) {
    try {
      resolvedActions = await resolveActionsFor(
        store,
        liveActionContext,
        liveSession,
        payload.actions,
      );
    } catch (error) {
      if (error instanceof ActionValidationError)
        throw new ActionRejectedError(error.message, error.code);
      throw error;
    }
    inputMessageId = payload.inputMessageId;
  } else if (
    turnOrigin === "player" &&
    type === "retry_turn" &&
    payload.recoverFromTurnId
  ) {
    const recorded = await recordedPlayerInput(
      store,
      sessionId,
      payload.recoverFromTurnId,
    );
    resolvedActions = recorded?.actions;
    inputMessageId = recorded?.messageId;
  }
  // A resent input whose turn is already saved would run the whole
  // turn only for the commit to refuse it: refuse it before it runs.
  // The commit's check stays the last line of defence.
  await assertInputUncommitted(store, sessionId, inputMessageId);
  // Refresh runtime activations from the session read under the lock.
  pluginRegistry.syncSessionActivations(sessionId, liveSession.activePlugins);
  ledger.useActiveRuntimes(pluginRegistry.getActiveRuntimes(sessionId));
  const activeRuntimes = ledger.activeRuntimes;
  const retryPlan =
    body.type === "retry_runtime" || body.type === "retry_failed_runtimes"
      ? await prepareRuntimeRetry(store, sessionId, body, activeRuntimes)
      : undefined;
  stream.setRetryScope(retryPlan?.scope);

  // The answer is checked here, under the lock, and stored by the start
  // phase with the `turn.started` marker: one decision answers the
  // interaction and starts its turn, so a second submit finds both or
  // neither.
  let submission: PreparedInteractionSubmission | undefined;
  const answers =
    type === "submit_actions" && resolvedActions
      ? interactionSubmissionPayload(resolvedActions)
      : undefined;
  if (answers) {
    const denied = await host.preflightFormApprovals(liveSession, answers);
    if (denied) throw await entryRejection(denied);
    submission = await request.submitInteraction(answers, {
      sessionId,
      locale: liveSession.locale,
    });
  }
  let playerInput: PlayerTurnInput | undefined;
  if (resolvedActions && liveActionContext) {
    try {
      playerInput = await playerTurnInput(
        liveActionContext,
        liveSession,
        resolvedActions,
        inputMessageId ?? crypto.randomUUID(),
        submission,
      );
    } catch (error) {
      if (error instanceof ActionValidationError)
        throw new ActionRejectedError(error.message, error.code);
      throw error;
    }
  }
  root.rememberSeat(playerInput?.actions);
  if (turnArgs.generated && !control.canAdvance)
    return { stopped: true as const };
  const registeredTurnControl = control.beginTurn(turnArgs.turnId);
  if (control.signal.aborted) {
    // Stopped while this turn was being admitted: it does not start.
    if (turnArgs.origin === "continuation" && !turnArgs.generated)
      await ledger.recordStoppedContinuation(turnArgs.turnId);
    return { stopped: true as const };
  }
  const executionSignal = host.workSignal;
  const turnControl = {
    ...registeredTurnControl,
    ...(executionSignal ? { executionSignal } : {}),
  };
  const commitSignal = executionSignal
    ? AbortSignal.any([control.signal, executionSignal])
    : control.signal;
  commitSignal.throwIfAborted();
  // Progress display metadata follows the live manifests for this run.
  const outputKindByRuntime = new Map(
    activeRuntimes.map((runtime) => [
      runtime.name,
      runtime.outputKind ?? "system",
    ]),
  );
  return {
    stopped: false,
    liveSession,
    origin: turnOrigin,
    recovered,
    resolvedActions,
    playerInput,
    submission,
    retryPlan,
    activeRuntimes,
    turnControl,
    commitSignal,
    outputKindByRuntime,
  };
}
