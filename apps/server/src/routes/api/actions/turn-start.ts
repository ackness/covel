/**
 * Turn phase 2, under the settled session lock: start an admitted turn.
 *
 * It applies a start's lore override, prepares the player's input rows for
 * the commit, records `turn.started` (with an interaction answer, in one
 * transaction), announces the start on the stream, and builds what the
 * execution reads: the session's plugin settings, the hook scope and the
 * turn input. From `turn.started` on, a failure settles a started turn.
 */

import {
  createTraceRecorder,
  createTurnEmitter,
  snapshotUserSettings,
  type HookScope,
  type TraceRecorder,
  type TurnEmitter,
} from "@covel/runtime";
import { concealedRuntimeIds, type TurnInput } from "@covel/shared";
import type {
  InteractionRecordRow,
  MessageRecord,
  SessionRecord,
} from "@covel/store";
import { loadSessionPluginUserSettings } from "../plugin-user-settings.js";
import { buildSessionHookScope } from "../session/hook-scope.js";
import { recoveryAction } from "./execution-recovery.js";
import { actionRequestOf, storedActions } from "./submit-actions.js";
import type { PreparedTurn } from "./turn-preparation.js";
import type { TurnPhase, TurnStopped } from "./turn-request.js";

/** The player's chat row and interaction record, written by the commit. */
export interface PlayerInputWrites {
  readonly message: MessageRecord;
  readonly interaction: InteractionRecordRow;
}

/** A turn that recorded `turn.started`, ready to execute. */
export interface StartedTurn {
  readonly stopped: false;
  /** The live session, with a start's lore override applied. */
  readonly session: SessionRecord;
  /** The session was still in setup when this turn started. */
  readonly wasPreGamePending: boolean;
  readonly playerInputWrites: PlayerInputWrites | undefined;
  readonly trace: TraceRecorder;
  readonly emitter: TurnEmitter;
  /** World defaults under the player's settings, snapshotted for the turn. */
  readonly userSettings: TurnInput["userSettings"];
  readonly hookScope: HookScope;
  readonly turnInput: TurnInput;
}

export async function startPreparedTurn(
  phase: TurnPhase,
  prepared: PreparedTurn,
): Promise<StartedTurn | TurnStopped> {
  const { request, stream, ledger, turn: turnArgs } = phase;
  const { store, pluginRegistry, eventBus, body, host } = request;
  const { requestId, type, sessionId, model, payload } = body;
  const { control, root } = ledger;
  const { traceId } = stream;
  const {
    liveSession,
    recovered,
    resolvedActions,
    playerInput,
    submission,
    retryPlan,
    activeRuntimes,
  } = prepared;
  const turnOrigin = prepared.origin;
  const turnPlayerMessage = playerInput?.message ?? "";

  let effectiveSession = liveSession;
  if (
    type === "start_session" &&
    !turnArgs.generated &&
    payload.loreOverride !== undefined &&
    effectiveSession.metadata?.loreOverride !== payload.loreOverride
  ) {
    const updatedAt = new Date().toISOString();
    const metadata = {
      ...effectiveSession.metadata,
      loreOverride: payload.loreOverride,
    };
    await store.updateSession(sessionId, { metadata, updatedAt });
    effectiveSession = {
      ...effectiveSession,
      metadata,
      updatedAt,
    };
  }

  const wasPreGamePending = effectiveSession.phase === "setup";

  // Commit the REST message mirror and interaction row with proposals
  // and the TurnMessage journal. Rollback removes new mirror rows and
  // turn attachments, preserving any uploaded browser input intent.
  // Every action that renders (any text, or any plugin kind, with or
  // without text) yields a row, so its `metadata.actions` and its
  // `inputMessageId` are recorded; only an input that renders nothing
  // (an `advance`, an answer that does not echo) has none.
  const playerInputCreatedAt = new Date().toISOString();
  const playerInputWrites: PlayerInputWrites | undefined =
    playerInput && turnPlayerMessage
      ? {
          message: {
            id: playerInput.messageId,
            sessionId,
            role: "user" as const,
            content: playerInput.content,
            metadata: {
              turnId: turnArgs.turnId,
              actions: storedActions(playerInput.actions),
            },
            createdAt: playerInputCreatedAt,
          },
          interaction: {
            id: crypto.randomUUID(),
            sessionId,
            turnId: turnArgs.turnId,
            timestamp: playerInputCreatedAt,
            source: "player" as const,
            channel: "web" as const,
            type: playerInput.actions.some((action) => action.interaction)
              ? ("form-submit" as const)
              : playerInput.actions.every((action) => action.kind === "command")
                ? ("rpc-call" as const)
                : ("message" as const),
            payload: {
              content: playerInput.content,
              actionType: type,
            },
            createdAt: playerInputCreatedAt,
          },
        }
      : undefined;

  // Create trace recorder for this turn (persists all lifecycle events
  // to DB). Carries the SSE traceId so recorder rows correlate with
  // emitter + commit-pipeline rows under one traceId.
  const trace = createTraceRecorder(
    store,
    sessionId,
    turnArgs.turnId,
    traceId,
    stream.retryScope,
  );

  // Per-turn trace emitter — fans emit() into trace_events + eventBus. Threaded
  // down into ToolCallContext / llm-retry / hooks etc. via executeTurn deps.
  // Pass the SSE envelope's traceId so persisted trace_events.traceId matches
  // the live-streamed traceId/flowId (without it the emitter falls back to
  // turnId, breaking traceId correlation between SSE and /api/traces).
  const emitter = createTurnEmitter({
    store,
    eventBus,
    sessionId,
    turnId: turnArgs.turnId,
    traceId,
    retryScope: stream.retryScope,
    concealedRuntimeIds: concealedRuntimeIds(activeRuntimes),
  });

  // `phase` is persisted by the session-clock write in finalizeExecution.
  // There is no standalone `phase.changed` event; clients receive the
  // committed session state through normal snapshot/session refreshes.

  // Emit execution started (protocol: execution.started). Goes
  // through the serial write queue like every other stream write, so
  // it keeps its envelope order relative to forwarded bus events.
  const roundActions = playerInput?.actions ?? resolvedActions;
  const provenance = root.provenance(
    turnArgs.generated
      ? "advance"
      : (recovered?.kind ??
          (turnOrigin === "continuation" ? "opening" : "root")),
    roundActions,
  );
  const turnStarted = {
    advancement: provenance,
    runtimeCount: activeRuntimes.length,
    requestId,
    origin: turnOrigin,
    // A failed turn is retried with the same resolved actions. One
    // that answered an interaction is retried as `retry_turn`, from
    // the actions recorded here: the answer is already stored and
    // must not be submitted again.
    recoveryAction: playerInput
      ? playerInput.actions.some((action) => action.interaction)
        ? recoveryAction("retry_turn", {})
        : recoveryAction("submit_actions", {
            actions: playerInput.actions.map(actionRequestOf),
            inputMessageId: playerInput.messageId,
          })
      : recoveryAction(type, payload, turnOrigin === "continuation"),
    ...(playerInput
      ? {
          playerInput: {
            actions: playerInput.actions,
            messageId: playerInput.messageId,
          },
        }
      : {}),
  };
  if (turnArgs.generated) {
    if (!control.canAdvance) return { stopped: true as const };
    root.reserve();
  }
  ledger.enterTurn(turnArgs.turnId);
  if (submission) {
    const stored = submission;
    await store.withTransaction(async (tx) => {
      await stored.persist(tx);
      await createTraceRecorder(
        tx,
        sessionId,
        turnArgs.turnId,
        traceId,
      ).turnStarted(turnStarted);
    });
  } else {
    await trace.turnStarted(turnStarted);
  }
  ledger.markTurnStarted();
  if (submission) {
    // Envelope `turnId` is the follow-up turn; `interactionTurnId` is
    // the turn that asked.
    await stream.write("interaction.submitted", {
      interactionTurnId: submission.turnId,
      results: submission.results,
      ...(playerInputWrites
        ? {
            message: {
              id: playerInputWrites.message.id,
              content: playerInputWrites.message.content,
            },
          }
        : {}),
    });
  }
  await stream.write("execution.started", {
    status: "executing",
    runtimeCount: activeRuntimes.length,
  });

  if (turnArgs.generated)
    await ledger.publishAdvance(root.progress("running", stream.turnId));

  // Refresh the per-session character-tool overrides so create/update-
  // character expose the world's CharacterAttributeSchema directly to
  // the LLM (Phase 2). No-op when the schema isn't yet populated for
  // this session — handlers stay correct on schema-less sessions. The
  // optional-chain keeps tests with hand-built DI middleware working.
  await host.prepareToolsForSession?.(sessionId);

  // The outer session lock serializes the complete mutation pipeline:
  // player input, execution, proposal commits, lifecycle sync, and the
  // final automatic snapshot. For PG-backed deployments it uses
  // `pg_advisory_lock`; memory/sqlite use the in-process chain lock.
  // Resolve plugin userSettings for this turn: world-authored defaults
  // (WorldRecord.metadata.pluginSettings) merged under the player's
  // per-session overrides (X-Plugin-User-Settings header). The runtime's
  // resolveUserSettings fills any still-missing declared key from the
  // manifest default. Without this the scheduled loop only ever saw
  // manifest defaults — player + world tuning were silently dropped on the
  // main route (only plugin-rpc read the header).
  const userSettings = snapshotUserSettings(
    await loadSessionPluginUserSettings(
      store,
      effectiveSession,
      request.playerSettings,
    ),
  );

  const hookScope = buildSessionHookScope({
    pluginRegistry,
    activePluginIds: effectiveSession.activePlugins,
    userSettings,
    locale: effectiveSession.locale,
  });

  const turnInput = {
    sessionId,
    turnId: turnArgs.turnId,
    playerMessage: turnPlayerMessage,
    ...(roundActions ? { actions: roundActions } : {}),
    locale: request.locale,
    modelOverride: model,
    // `turnOrigin` is the flow (player turn or opening) that
    // `turn.started` records for recovery; the execution of a runtime
    // retry is `manual`, so it is not counted as a player turn.
    origin: request.isRuntimeRetry ? ("manual" as const) : turnOrigin,
    logicalTurnId: root.rootId,
    logicalTurn: root.logicalTurn,
    userSettings,
    // Snapshot session-level per-runtime slot overrides so the
    // turn executor can consult them when resolving each runtime's
    // model. Read from the record loaded under the lock, so an edit
    // made while this request queued is honoured.
    ...(effectiveSession.runtimeModelOverrides
      ? {
          runtimeModelOverrides: effectiveSession.runtimeModelOverrides,
        }
      : {}),
    ...(turnArgs.suppressPlayerMessage ? { suppressPlayerMessage: true } : {}),
    // Scoped retries share one execution and commit without counting
    // another player turn. Seeds are already checked under the lock.
    ...(type === "retry_runtime" || type === "retry_failed_runtimes"
      ? {
          manualTrigger: {
            ...(type === "retry_failed_runtimes"
              ? { runtimeIds: payload.runtimeIds }
              : { runtimeId: payload.runtimeId }),
            ...(stream.retryScope
              ? { sourceTurnId: stream.retryScope.sourceTurnId }
              : {}),
            retrySeedResults: retryPlan?.seedResults,
            presentationJobs: retryPlan?.presentationJobs,
            presentationSnapshots: retryPlan?.presentationSnapshots,
          },
        }
      : {}),
  };
  return {
    stopped: false,
    session: effectiveSession,
    wasPreGamePending,
    playerInputWrites,
    trace,
    emitter,
    userSettings,
    hookScope,
    turnInput,
  };
}
