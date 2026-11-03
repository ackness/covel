import { admitCommittedStory } from "@/lib/reveal/committed-stories.js";
import { readExecutionProgress } from "./execution-progress.js";
import { handlePluginFaultNotice } from "./fault-notices.js";
import i18n from "i18next";
import type { MutableRef } from "./runtime-refs.js";
import { emitToast } from "@/lib/toast-channel.js";
import { applyUiSlotEvent } from "@/stores/ui-slot-store.js";
import { reasoningAction } from "./reasoning.js";
import {
  isAssetGenerateView,
  PLAYER_ABORT_REASON,
  stageSchema,
  storyMessageSegmentSchema,
  storyOperationFailuresSchema,
  type CovelEventType,
  type ExecutionAdvancePayload,
} from "@covel/shared";
import * as api from "@/services/api";
import {
  reducePluginDataChanged,
  reduceTurnResumed,
  reduceTurnSuspended,
} from "./event-reducers.js";
import {
  buildDeferredExecutionStep,
  buildJobStatusExecutionStep,
  createExecutionStepUpdate,
  runtimeJobCorrelationId,
} from "./execution-steps.js";
import { invalidateSessionResource } from "./session-resource-reads.js";
import { getSettings } from "@/settings/store.js";
import {
  draftWasShown,
  outputDraftAction,
  readLiveOutputPreference,
} from "./output-drafts.js";
import { retryStepMetadata } from "./execution-projection.js";
import { buildRetryAttemptSteps } from "./execution-attempts.js";
import type {
  AssetProgressEvent,
  ExecutionStep,
  SessionAction,
  SessionState,
  SnapshotCharacter,
  StreamMessage,
} from "./types.js";

/** `error.occurred` codes shown in the player's language, not the server text. */
const STALE_RETRY = "session.reasonRetryStale";
const ERROR_CODE_REASONS: ReadonlyMap<string, string> = new Map([
  ["session_busy", "session.reasonSessionBusy"],
  ["input_already_committed", "session.reasonInputAlreadyCommitted"],
  ["retry_source_not_found", STALE_RETRY],
  ["retry_source_not_committed", STALE_RETRY],
  ["retry_source_not_original", STALE_RETRY],
  ["retry_source_stale", STALE_RETRY],
  ["retry_target_not_active", STALE_RETRY],
  ["retry_target_not_failed", STALE_RETRY],
  ["recovery_unavailable", STALE_RETRY],
]);

export interface SseEventHandlerDeps {
  dispatch: (action: SessionAction) => void;
  sessionIdRef: MutableRef<string | null>;
  stateRef: MutableRef<SessionState>;
  lastBackfilledTurnIdRef: MutableRef<string | null>;
}

export type SseEventHandler = (envelope: api.SseEnvelope) => void;

export function addBlockMessageFromSse(
  deps: Pick<SseEventHandlerDeps, "dispatch">,
  block: Record<string, unknown>,
  payload: Record<string, unknown>,
  timestamp: string,
  fallbackTurnId?: string,
): void {
  const blockMeta = block.meta as Record<string, unknown> | undefined;
  const blockId =
    (block.id as string) ??
    (payload.proposalId as string) ??
    crypto.randomUUID();
  const blockTurnId =
    (blockMeta?.turnId as string | undefined) ??
    (payload.turnId as string | undefined) ??
    fallbackTurnId;
  const runtimeId =
    (blockMeta?.runtimeId as string | undefined) ??
    (payload.runtimeId as string | undefined) ??
    undefined;
  const msg: StreamMessage = {
    id: blockId,
    role: "assistant",
    content: "",
    timestamp,
    turnId: blockTurnId,
    runtimeId,
    kind: "plugin",
    block,
  };
  deps.dispatch({ type: "ADD_MESSAGE", message: msg });
}

function toRuntimeCompletedStatus(rawStatus: unknown): ExecutionStep["status"] {
  if (rawStatus === "deferred") return "deferred";
  if (rawStatus === "suspended") return "suspended";
  if (rawStatus === "skipped") return "skipped";
  if (rawStatus === "failed") return "failed";
  return "completed";
}

function toAssetProgressEvent(
  payload: Record<string, unknown>,
  timestamp: string,
): AssetProgressEvent | null {
  const phase = payload.phase;
  if (typeof phase !== "string" || phase.length === 0) return null;

  return {
    phase,
    timestamp,
    ...(typeof payload.assetId === "string" && payload.assetId.length > 0
      ? { assetId: payload.assetId }
      : {}),
    ...(typeof payload.percent === "number" && Number.isFinite(payload.percent)
      ? { percent: payload.percent }
      : {}),
    ...(typeof payload.message === "string" && payload.message.length > 0
      ? { message: payload.message }
      : {}),
    ...(typeof payload.modality === "string" && payload.modality.length > 0
      ? { modality: payload.modality }
      : {}),
    ...(typeof payload.pluginId === "string" && payload.pluginId.length > 0
      ? { pluginId: payload.pluginId }
      : {}),
    ...(typeof payload.runtimeId === "string" && payload.runtimeId.length > 0
      ? { runtimeId: payload.runtimeId }
      : {}),
    ...(payload.meta &&
    typeof payload.meta === "object" &&
    !Array.isArray(payload.meta)
      ? { meta: payload.meta as Record<string, unknown> }
      : {}),
  };
}

export function createSseEventHandler(
  deps: SseEventHandlerDeps,
): SseEventHandler {
  return (envelope) => {
    const { payload, turnId } = envelope;
    // Nothing aborts the previous action stream when the player switches
    // sessions mid-turn, so envelopes from the old session keep arriving on
    // the still-open connection. Every downstream write stamps
    // `sessionIdRef.current` (the NEW session), which in local/IDB mode
    // persists the old session's narrative into the new one's history. Drop
    // foreign envelopes before publishing any session state.
    const currentSessionId = deps.sessionIdRef.current;
    if (
      envelope.sessionId &&
      currentSessionId &&
      envelope.sessionId !== currentSessionId
    ) {
      return;
    }
    if (
      currentSessionId &&
      applyUiSlotEvent(currentSessionId, envelope.type, payload, turnId)
    )
      return;
    // `SseEnvelope.type` is the raw, untrusted wire string. Narrow it to the
    // closed `CovelEventType` union so the switch below is exhaustiveness-
    // checked: every union member must be either handled or explicitly
    // ignored, and genuinely unknown wire strings fall through to
    // `assertNeverEvent` (warn — never silently dropped).
    if (turnId && turnId !== deps.lastBackfilledTurnIdRef.current) {
      deps.lastBackfilledTurnIdRef.current = turnId;
    }

    // Deferred work has its own step builder. Handle it here, then keep
    // exhaustive checking for the remaining event vocabulary.
    if (envelope.type === "runtime.deferred") {
      const step = buildDeferredExecutionStep(
        payload,
        turnId,
        envelope.timestamp,
      );
      if (step) deps.dispatch({ type: "UPSERT_EXECUTION_STEP", step });
      return;
    }
    const eventType = envelope.type as Exclude<
      CovelEventType,
      "runtime.deferred"
    >;

    switch (eventType) {
      case "plugin.fault.latched":
      case "plugin.fault.cleared":
        handlePluginFaultNotice(deps, eventType, payload, turnId);
        break;
      case "plugin.fault.counted":
        break;
      case "llm.responded":
      case "gateway.responded": {
        const action = reasoningAction(
          eventType,
          payload,
          turnId,
          envelope.timestamp,
        );
        if (action) deps.dispatch(action);
        break;
      }
      case "tool.calling":
      case "tool.completed":
      case "tool.failed":
      case "llm.calling":
      case "step.started":
      case "step.completed": {
        const progress = readExecutionProgress(eventType, payload, turnId);
        if (progress) deps.dispatch({ type: "EXECUTION_PROGRESS", progress });
        break;
      }
      case "narrative.completed": {
        const content =
          typeof payload.content === "string" ? payload.content : "";
        const runtimeId = (payload.runtimeId as string) ?? "unknown";
        const msgId =
          typeof payload.messageId === "string" ? payload.messageId : "";
        const completedKind = payload.kind as string;
        if (completedKind === "story") {
          if (content && msgId) {
            // Segments carry the stage nameplates and the HUD speaker.
            const segments = storyMessageSegmentSchema
              .array()
              .safeParse(payload.segments);
            const msg: StreamMessage = {
              id: msgId,
              role: "assistant",
              content,
              kind: "story",
              timestamp: envelope.timestamp,
              turnId,
              runtimeId: runtimeId !== "unknown" ? runtimeId : undefined,
              ...(segments.success ? { segments: segments.data } : {}),
            };
            // Surfaces that showed this story as a draft do not reveal it
            // a second time; it simply becomes the committed message.
            admitCommittedStory(
              envelope.sessionId,
              msg,
              !!turnId &&
                draftWasShown(
                  deps.stateRef.current.outputDrafts,
                  turnId,
                  runtimeId,
                  liveOutputPreference(),
                ),
            );
            deps.dispatch({
              type: "COMPLETE_MESSAGE",
              turnId: turnId ?? "unknown",
              runtimeId,
              message: msg,
            });
          }
        }

        if (turnId)
          deps.dispatch({ type: "CLEAR_OUTPUT_DRAFT", turnId, runtimeId });
        // The browser stores the complete post-action checkpoint after the SSE
        // stream closes. Persisting individual server messages here would
        // create local revisions that race and conflict with that checkpoint.
        break;
      }
      case "output.draft":
      case "output.retracted":
      case "output.accepted": {
        const action = outputDraftAction(eventType, payload);
        if (action) deps.dispatch(action);
        break;
      }
      case "interaction.requested": {
        const block = payload.block as Record<string, unknown>;
        if (block) {
          addBlockMessageFromSse(
            deps,
            block,
            payload,
            envelope.timestamp,
            turnId,
          );
        }
        break;
      }
      case "ui.rendered": {
        addBlockMessageFromSse(
          deps,
          payload.block as Record<string, unknown>,
          payload,
          envelope.timestamp,
          turnId,
        );
        break;
      }
      case "execution.started": {
        for (const step of buildRetryAttemptSteps(
          payload,
          turnId,
          envelope.timestamp,
          deps.stateRef.current.executionSteps,
        ))
          deps.dispatch({ type: "UPSERT_EXECUTION_STEP", step });
        break;
      }
      case "runtime.started": {
        const runtimeId = (payload.runtimeId as string) ?? "unknown";
        const pluginId = (payload.pluginId as string) ?? "";
        const label = payload.label as string | undefined;
        const stage = stageSchema.safeParse(payload.stage);
        deps.dispatch({
          type: "UPSERT_EXECUTION_STEP",
          step: {
            runtimeId,
            pluginId,
            ...(stage.success ? { stage: stage.data } : {}),
            status: "running",
            attemptStatus: "pending",
            label,
            turnId,
            ...(typeof payload.runId === "string" && payload.runId
              ? { runId: payload.runId }
              : {}),
            ...(payload.resumed === true ? { resumed: true } : {}),
            ...(typeof payload.resumeSourceRunId === "string" &&
            payload.resumeSourceRunId
              ? { resumeSourceRunId: payload.resumeSourceRunId }
              : {}),
            startedAt: envelope.timestamp,
            ...retryStepMetadata(payload, turnId),
          },
        });
        break;
      }
      case "runtime.completed": {
        deps.dispatch({
          type: "UPSERT_EXECUTION_STEP",
          step: createExecutionStepUpdate({
            payload,
            status: toRuntimeCompletedStatus(payload.status),
            turnId,
          }),
        });
        break;
      }
      case "runtime.failed": {
        if (turnId && typeof payload.runtimeId === "string")
          deps.dispatch({
            type: "CLEAR_OUTPUT_DRAFT",
            turnId,
            runtimeId: payload.runtimeId,
          });
        deps.dispatch({
          type: "UPSERT_EXECUTION_STEP",
          step: createExecutionStepUpdate({
            payload,
            status: "failed",
            turnId,
          }),
        });
        break;
      }
      case "runtime.skipped": {
        deps.dispatch({
          type: "UPSERT_EXECUTION_STEP",
          step: createExecutionStepUpdate({
            payload,
            status: "skipped",
            turnId,
          }),
        });
        break;
      }
      case "execution.advance": {
        deps.dispatch({
          type: "SET_ADVANCE",
          advance: payload as unknown as ExecutionAdvancePayload,
        });
        break;
      }
      case "execution.round.completed":
      case "execution.completed": {
        // committed is a required boolean on the wire; treat missing/other
        // values as uncommitted so optimistic output doesn't linger silently.
        const committed = payload.committed === true;
        if (turnId)
          deps.dispatch({
            type: "SET_TURN_ATTEMPT_STATUS",
            turnId,
            status: payload.committed === true ? "committed" : "failed",
            sourceFailedRuntimeIds: retryStepMetadata(payload, turnId)
              .sourceFailedRuntimeIds,
            ...(typeof payload.abortReason === "string"
              ? { abortReason: payload.abortReason }
              : {}),
          });
        const abortReason = payload.abortReason as string | undefined;
        if (!committed && abortReason !== PLAYER_ABORT_REASON) {
          deps.dispatch({
            type: "SET_EXECUTION_ERROR",
            ...(turnId ? { turnId } : {}),
            error:
              (payload.error as string | undefined) ??
              "__i18n:session.reasonExecutionCommitFailed__",
          });
        } else if (abortReason && abortReason !== PLAYER_ABORT_REASON) {
          deps.dispatch({ type: "SET_EXECUTION_ERROR", error: abortReason });
        }
        if (envelope.type === "execution.completed") {
          deps.dispatch({ type: "SET_EXECUTING", value: false });
          deps.dispatch({ type: "SET_ADVANCE", advance: null });
        }
        deps.dispatch({
          type: "FINALIZE_HANGING_RUNTIMES",
          ...(turnId ? { turnId } : {}),
          reason: "__i18n:session.reasonConnectionClosed__",
        });
        // Whatever was not committed by now never will be.
        deps.dispatch({
          type: "CLEAR_OUTPUT_DRAFTS",
          ...(turnId ? { turnId } : {}),
        });
        break;
      }
      case "turn.suspended": {
        reduceTurnSuspended(deps.dispatch, payload, {
          sessionId: envelope.sessionId,
          timestamp: envelope.timestamp,
          turnId,
        });
        break;
      }
      case "turn.resumed": {
        reduceTurnResumed(deps.dispatch, payload, {
          sessionId: envelope.sessionId,
          timestamp: envelope.timestamp,
          turnId,
        });
        break;
      }
      case "event.emitted":
      case "ui.slot.changed":
      case "ui.slot.preview":
      case "ui.slot.cleared":
        break;
      // Projected server-side into ui.slot.preview; no direct client state.
      case "domain-event.previewed":
        break;
      case "plugin-data.changed": {
        reducePluginDataChanged(deps.dispatch, payload, envelope.sessionId);
        break;
      }
      case "dimensions.changed":
      case "dimensions.settlement.changed": {
        invalidateSessionResource(deps.dispatch, [
          "game-state",
          envelope.sessionId,
        ]);
        deps.dispatch({ type: "MERGE_COMMITTED_DIMENSIONS", payload });
        break;
      }
      case "character-schema.changed": {
        invalidateSessionResource(deps.dispatch, [
          "game-state",
          envelope.sessionId,
        ]);
        deps.dispatch({
          type: "SET_CHARACTER_SCHEMA",
          schema: payload.schema,
        });
        break;
      }
      case "character.upserted": {
        const character = payload.character;
        if (character && typeof character === "object") {
          invalidateSessionResource(deps.dispatch, [
            "game-state",
            envelope.sessionId,
          ]);
          deps.dispatch({
            type: "UPSERT_GAME_STATE_CHARACTER",
            character: character as SnapshotCharacter,
          });
        }
        break;
      }
      case "asset.generated": {
        const asset = isAssetGenerateView(payload.asset)
          ? payload.asset
          : undefined;
        const turnIdFromPayload =
          (payload.turnId as string | undefined) ?? turnId;
        if (!asset || !turnIdFromPayload) break;
        deps.dispatch({
          type: "ASSET_GENERATED",
          turnId: turnIdFromPayload,
          asset,
        });
        break;
      }
      case "asset.progress": {
        const turnIdFromPayload =
          (payload.turnId as string | undefined) ?? turnId;
        if (!turnIdFromPayload) break;
        const progress = toAssetProgressEvent(payload, envelope.timestamp);
        if (!progress) break;
        deps.dispatch({
          type: "ASSET_PROGRESS",
          turnId: turnIdFromPayload,
          progress,
        });
        break;
      }
      case "error.occurred": {
        if (turnId)
          deps.dispatch({
            type: "SET_TURN_ATTEMPT_STATUS",
            turnId,
            status: "failed",
          });
        const code =
          typeof payload.code === "string" ? payload.code : undefined;
        const reason = code ? ERROR_CODE_REASONS.get(code) : undefined;
        deps.dispatch({
          type: "SET_EXECUTION_ERROR",
          error: reason
            ? `__i18n:${reason}__`
            : ((payload.message as string) ??
              "__i18n:session.reasonExecutionFailed__"),
        });
        deps.dispatch({ type: "SET_EXECUTING", value: false });
        deps.dispatch({ type: "SET_ADVANCE", advance: null });
        deps.dispatch({
          type: "FINALIZE_HANGING_RUNTIMES",
          ...(turnId ? { turnId } : {}),
          reason: "__i18n:session.reasonConnectionClosed__",
        });
        // Whatever was not committed by now never will be.
        deps.dispatch({
          type: "CLEAR_OUTPUT_DRAFTS",
          ...(turnId ? { turnId } : {}),
        });
        break;
      }
      case "operation.failed": {
        if (
          payload.sessionId !== deps.sessionIdRef.current ||
          payload.sessionId !== envelope.sessionId ||
          payload.turnId !== envelope.turnId ||
          typeof payload.turnId !== "string" ||
          !storyOperationFailuresSchema.safeParse({ count: payload.count })
            .success ||
          !Array.isArray(payload.messages)
        )
          return;
        const messages = payload.messages.flatMap((item: unknown) => {
          if (!item || typeof item !== "object") return [];
          const row = item as Record<string, unknown>;
          const parsed = storyOperationFailuresSchema.safeParse({
            count: row.count,
          });
          return typeof row.messageId === "string" && parsed.success
            ? [{ messageId: row.messageId, count: parsed.data.count }]
            : [];
        });
        deps.dispatch({
          type: "SET_OPERATION_FAILURES",
          sessionId: payload.sessionId as string,
          turnId: payload.turnId,
          messages,
        });
        emitToast(
          "info",
          i18n.t("session.operationFailedNotice", {
            count: payload.count as number,
          }),
        );
        return;
      }
      // A proposal failed to commit: part of this turn's writes did
      // not land. Surface it as an execution error so the player sees a
      // visible failure instead of a silently incomplete turn (the server
      // also withholds turn.completed / auto-snapshot in this case).
      case "proposal.failed": {
        const proposalType = (payload.proposalType as string) ?? "proposal";
        const error = (payload.error as string) ?? "commit failed";
        deps.dispatch({
          type: "SET_EXECUTION_ERROR",
          error: `${proposalType}: ${error}`,
        });
        break;
      }
      // Known CovelEvents that the action-stream handler intentionally does
      // NOT render: runtime-internal trace events forwarded onto this stream
      // (consumed by the /debug timeline via the subscription channel) plus
      // reserved lifecycle events handled elsewhere. Listed explicitly so the
      // `assertNeverEvent` exhaustiveness guard below stays green — adding a
      // new CovelEvent forces a conscious decision here (handle or ignore).
      case "ui.part.update":
      case "world.dimensions.changed":
      case "state.snapshot.created":
      case "session.forked":

      case "message.completed":
      case "block.emitted":
      case "hook.fired":
      case "hook.rewrote":
      case "hook.aborted":
      case "plugin.service.completed":
      // Command lifecycle is trace-only and never forwarded to this action
      // stream; keep the closed event union exhaustive for future changes.
      case "command.invoked":
      case "command.completed":
      case "command.failed":
      // Recursive-runtime trace events: subscription-channel only, never
      // forwarded to this action stream — listed for exhaustiveness only.
      case "recursive.calling":
      case "recursive.completed":
      case "recursive.failed":
      // Sub-agent runs: trace-only, never forwarded to this action stream.
      case "subagent.started":
      case "subagent.completed":
      case "subagent.failed":
      case "subagent.writes-dropped":
      // Function-runtime trace events: drive the /debug timeline via the
      // subscription channel / trace_events, not this action renderer.
      // gateway.* forward to the action stream (llm.* parity) but the action
      // handler ignores them here, same as tool.*/llm.*.
      case "function.executing":
      case "function.completed":
      case "presentation.completed":
      case "gateway.calling":
      case "gateway.failed":
      // Plugin-utils provider-call trace: /debug-only, same as gateway.*
      case "utils.fetch.calling":
      case "utils.fetch.responded":
      case "utils.fetch.failed":
      // Prompt-budget prune trace: /debug reads it from trace_events.
      case "context.pruned":
      case "context.compaction.failed":
      case "commit.fanout.failed":
        break;
      case "job-status.updated": {
        const jobId = runtimeJobCorrelationId(payload);
        const existing = deps.stateRef.current.executionSteps.find(
          (step) =>
            (jobId && step.jobId === jobId) ||
            (step.detached === true &&
              step.runtimeId === payload.runtimeId &&
              step.turnId === turnId),
        );
        const step = buildJobStatusExecutionStep(payload, existing, turnId);
        if (step) {
          deps.dispatch({ type: "UPSERT_EXECUTION_STEP", step });
        }
        break;
      }
      default:
        assertNeverEvent(eventType);
    }
  };
}

function liveOutputPreference() {
  try {
    return readLiveOutputPreference(getSettings().get("ui.liveOutput"));
  } catch {
    return readLiveOutputPreference(undefined);
  }
}

/**
 * Exhaustiveness guard for the SSE event switch. `eventType` is typed `never`
 * here only when every `CovelEventType` is handled or explicitly ignored
 * above — adding a new event without a case fails compilation. At runtime a
 * malformed / future wire string reaches this branch; warn instead of
 * silently dropping it (the old switch had no default).
 */
function assertNeverEvent(eventType: never): void {
  console.warn(`[sse-handler] unhandled SSE event type: ${String(eventType)}`);
}

export function applyResumeEvents(
  events: api.ResumeSuspensionResponse["events"],
  handleSseEvent: SseEventHandler,
): void {
  for (const event of events) {
    handleSseEvent({
      type: event.type,
      requestId: crypto.randomUUID(),
      traceId: event.turnId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      flowId: event.turnId,
      seq: -1,
      timestamp: event.timestamp,
      payload: {
        ...event.payload,
        runtimeId: event.source.runtimeId,
        pluginId: event.source.pluginId,
      },
    });
  }
}
