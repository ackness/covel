import { admitCommittedStory } from "@/lib/reveal/committed-stories.js";
import { readExecutionProgress } from "./execution-progress.js";
import { handlePluginFaultNotice } from "./fault-notices.js";
import i18n from "i18next";
import type { MutableRef } from "./runtime-refs.js";
import { pushNotice } from "@/lib/notice-center.js";
import { reasoningAction } from "./reasoning.js";
import {
  isAssetGenerateView,
  PLAYER_ABORT_REASON,
  stageSchema,
  storyMessageSegmentSchema,
  storyOperationFailuresSchema,
  type CovelEventType,
  type ExecutionAdvancePayload,
  type SseEnvelope,
} from "@covel/shared";
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
import { errorCodeReason } from "./error-code-reasons.js";
import type {
  AssetProgressEvent,
  ExecutionStep,
  SessionAction,
  SessionState,
  SnapshotCharacter,
  StreamMessage,
} from "./types.js";

export interface SseEventHandlerDeps {
  dispatch: (action: SessionAction) => void;
  sessionIdRef: MutableRef<string | null>;
  stateRef: MutableRef<SessionState>;
  lastBackfilledTurnIdRef: MutableRef<string | null>;
}

/** What one route receives: the event already narrowed to its type. */
export interface SseEventContext<K extends CovelEventType = CovelEventType> {
  readonly type: K;
  readonly deps: SseEventHandlerDeps;
  readonly envelope: SseEnvelope;
  readonly payload: SseEnvelope["payload"];
  readonly turnId: string;
}

/**
 * A route either handles the event or is explicitly `"ignored"`: the action
 * stream deliberately does nothing with it.
 */
export type SseEventRoute<K extends CovelEventType> =
  "ignored" | ((context: SseEventContext<K>) => void);

/** Exactly one route per protocol event type. */
export type SseEventRouteTable = {
  readonly [K in CovelEventType]: SseEventRoute<K>;
};

// ── Shared helpers ─────────────────────────────────────────────────

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function liveOutputPreference() {
  try {
    return readLiveOutputPreference(getSettings().get("ui.liveOutput"));
  } catch {
    return readLiveOutputPreference(undefined);
  }
}

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

/** Settles a turn that can no longer commit anything more. */
function settleHangingTurn(
  dispatch: SseEventHandlerDeps["dispatch"],
  turnId: string,
): void {
  dispatch({
    type: "FINALIZE_HANGING_RUNTIMES",
    ...(turnId ? { turnId } : {}),
    reason: "__i18n:session.reasonConnectionClosed__",
  });
  // Whatever was not committed by now never will be.
  dispatch({
    type: "CLEAR_OUTPUT_DRAFTS",
    ...(turnId ? { turnId } : {}),
  });
}

// ── Routes ─────────────────────────────────────────────────────────

function handlePluginFault({
  type,
  deps,
  payload,
  turnId,
}: SseEventContext<"plugin.fault.latched" | "plugin.fault.cleared">): void {
  handlePluginFaultNotice(deps, type, payload, turnId);
}

function handleReasoning({
  type,
  deps,
  payload,
  turnId,
  envelope,
}: SseEventContext<"llm.responded" | "gateway.responded">): void {
  const action = reasoningAction(type, payload, turnId, envelope.timestamp);
  if (action) deps.dispatch(action);
}

function handleExecutionProgress({
  type,
  deps,
  payload,
  turnId,
}: SseEventContext<
  | "tool.calling"
  | "tool.completed"
  | "tool.failed"
  | "llm.calling"
  | "step.started"
  | "step.completed"
>): void {
  const progress = readExecutionProgress(type, payload, turnId);
  if (progress) deps.dispatch({ type: "EXECUTION_PROGRESS", progress });
}

function handleNarrativeCompleted({
  deps,
  envelope,
  payload,
  turnId,
}: SseEventContext<"narrative.completed">): void {
  const content = typeof payload.content === "string" ? payload.content : "";
  const runtimeId = (payload.runtimeId as string) ?? "unknown";
  const msgId = typeof payload.messageId === "string" ? payload.messageId : "";
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

  if (turnId) deps.dispatch({ type: "CLEAR_OUTPUT_DRAFT", turnId, runtimeId });
  // The browser stores the complete post-action checkpoint after the SSE
  // stream closes. Persisting individual server messages here would
  // create local revisions that race and conflict with that checkpoint.
}

function handleOutputDraft({
  type,
  deps,
  payload,
}: SseEventContext<
  "output.draft" | "output.retracted" | "output.accepted"
>): void {
  const action = outputDraftAction(type, payload);
  if (action) deps.dispatch(action);
}

function handleInteractionRequested({
  deps,
  envelope,
  payload,
  turnId,
}: SseEventContext<"interaction.requested">): void {
  const block = payload.block as Record<string, unknown>;
  if (block) {
    addBlockMessageFromSse(deps, block, payload, envelope.timestamp, turnId);
  }
}

function handleUiRendered({
  deps,
  envelope,
  payload,
  turnId,
}: SseEventContext<"ui.rendered">): void {
  addBlockMessageFromSse(
    deps,
    payload.block as Record<string, unknown>,
    payload,
    envelope.timestamp,
    turnId,
  );
}

function handleExecutionStarted({
  deps,
  envelope,
  payload,
  turnId,
}: SseEventContext<"execution.started">): void {
  for (const step of buildRetryAttemptSteps(
    payload,
    turnId,
    envelope.timestamp,
    deps.stateRef.current.executionSteps,
  ))
    deps.dispatch({ type: "UPSERT_EXECUTION_STEP", step });
}

function handleRuntimeStarted({
  deps,
  envelope,
  payload,
  turnId,
}: SseEventContext<"runtime.started">): void {
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
}

/** Deferred work has its own step builder. */
function handleRuntimeDeferred({
  deps,
  envelope,
  payload,
  turnId,
}: SseEventContext<"runtime.deferred">): void {
  const step = buildDeferredExecutionStep(payload, turnId, envelope.timestamp);
  if (step) deps.dispatch({ type: "UPSERT_EXECUTION_STEP", step });
}

function handleRuntimeCompleted({
  deps,
  payload,
  turnId,
}: SseEventContext<"runtime.completed">): void {
  deps.dispatch({
    type: "UPSERT_EXECUTION_STEP",
    step: createExecutionStepUpdate({
      payload,
      status: toRuntimeCompletedStatus(payload.status),
      turnId,
    }),
  });
}

function handleRuntimeFailed({
  deps,
  payload,
  turnId,
}: SseEventContext<"runtime.failed">): void {
  if (turnId && typeof payload.runtimeId === "string")
    deps.dispatch({
      type: "CLEAR_OUTPUT_DRAFT",
      turnId,
      runtimeId: payload.runtimeId,
    });
  deps.dispatch({
    type: "UPSERT_EXECUTION_STEP",
    step: createExecutionStepUpdate({ payload, status: "failed", turnId }),
  });
}

function handleRuntimeSkipped({
  deps,
  payload,
  turnId,
}: SseEventContext<"runtime.skipped">): void {
  deps.dispatch({
    type: "UPSERT_EXECUTION_STEP",
    step: createExecutionStepUpdate({ payload, status: "skipped", turnId }),
  });
}

function handleExecutionAdvance({
  deps,
  payload,
}: SseEventContext<"execution.advance">): void {
  deps.dispatch({
    type: "SET_ADVANCE",
    advance: payload as unknown as ExecutionAdvancePayload,
  });
}

function handleExecutionSettled({
  type,
  deps,
  payload,
  turnId,
}: SseEventContext<"execution.round.completed" | "execution.completed">): void {
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
  if (type === "execution.completed") {
    deps.dispatch({ type: "SET_EXECUTING", value: false });
    deps.dispatch({ type: "SET_ADVANCE", advance: null });
  }
  settleHangingTurn(deps.dispatch, turnId);
}

function handleTurnSuspended({
  deps,
  envelope,
  payload,
  turnId,
}: SseEventContext<"turn.suspended">): void {
  reduceTurnSuspended(deps.dispatch, payload, {
    sessionId: envelope.sessionId,
    timestamp: envelope.timestamp,
    turnId,
  });
}

function handleTurnResumed({
  deps,
  envelope,
  payload,
  turnId,
}: SseEventContext<"turn.resumed">): void {
  reduceTurnResumed(deps.dispatch, payload, {
    sessionId: envelope.sessionId,
    timestamp: envelope.timestamp,
    turnId,
  });
}

function handlePluginDataChanged({
  deps,
  envelope,
  payload,
}: SseEventContext<"plugin-data.changed">): void {
  reducePluginDataChanged(deps.dispatch, payload, envelope.sessionId);
}

function handleDimensionsChanged({
  deps,
  envelope,
  payload,
}: SseEventContext<
  "dimensions.changed" | "dimensions.settlement.changed"
>): void {
  invalidateSessionResource(deps.dispatch, ["game-state", envelope.sessionId]);
  deps.dispatch({ type: "MERGE_COMMITTED_DIMENSIONS", payload });
}

function handleCharacterSchemaChanged({
  deps,
  envelope,
  payload,
}: SseEventContext<"character-schema.changed">): void {
  invalidateSessionResource(deps.dispatch, ["game-state", envelope.sessionId]);
  deps.dispatch({ type: "SET_CHARACTER_SCHEMA", schema: payload.schema });
}

function handleCharacterUpserted({
  deps,
  envelope,
  payload,
}: SseEventContext<"character.upserted">): void {
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
}

function handleAssetGenerated({
  deps,
  payload,
  turnId,
}: SseEventContext<"asset.generated">): void {
  const asset = isAssetGenerateView(payload.asset) ? payload.asset : undefined;
  const turnIdFromPayload = (payload.turnId as string | undefined) ?? turnId;
  if (!asset || !turnIdFromPayload) return;
  deps.dispatch({ type: "ASSET_GENERATED", turnId: turnIdFromPayload, asset });
}

function handleAssetProgress({
  deps,
  envelope,
  payload,
  turnId,
}: SseEventContext<"asset.progress">): void {
  const turnIdFromPayload = (payload.turnId as string | undefined) ?? turnId;
  if (!turnIdFromPayload) return;
  const progress = toAssetProgressEvent(payload, envelope.timestamp);
  if (!progress) return;
  deps.dispatch({
    type: "ASSET_PROGRESS",
    turnId: turnIdFromPayload,
    progress,
  });
}

function handleErrorOccurred({
  deps,
  payload,
  turnId,
}: SseEventContext<"error.occurred">): void {
  if (turnId)
    deps.dispatch({
      type: "SET_TURN_ATTEMPT_STATUS",
      turnId,
      status: "failed",
    });
  const reason = errorCodeReason(payload.code);
  deps.dispatch({
    type: "SET_EXECUTION_ERROR",
    error: reason
      ? `__i18n:${reason}__`
      : ((payload.message as string) ??
        "__i18n:session.reasonExecutionFailed__"),
  });
  deps.dispatch({ type: "SET_EXECUTING", value: false });
  deps.dispatch({ type: "SET_ADVANCE", advance: null });
  settleHangingTurn(deps.dispatch, turnId);
}

function handleOperationFailed({
  deps,
  envelope,
  payload,
}: SseEventContext<"operation.failed">): void {
  if (
    payload.sessionId !== deps.sessionIdRef.current ||
    payload.sessionId !== envelope.sessionId ||
    payload.turnId !== envelope.turnId ||
    typeof payload.turnId !== "string" ||
    !storyOperationFailuresSchema.safeParse({ count: payload.count }).success ||
    !Array.isArray(payload.messages)
  )
    return;
  const messages = payload.messages.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const parsed = storyOperationFailuresSchema.safeParse({ count: row.count });
    return typeof row.messageId === "string" && parsed.success
      ? [{ messageId: row.messageId, count: parsed.data.count }]
      : [];
  });
  // The story footer keeps the persistent line for this turn.
  deps.dispatch({
    type: "SET_OPERATION_FAILURES",
    sessionId: payload.sessionId as string,
    turnId: payload.turnId,
    messages,
  });
}

/**
 * A proposal failed to commit: part of this turn's writes did not land.
 * Surface it as an execution error so the player sees a visible failure
 * instead of a silently incomplete turn (the server also withholds
 * turn.completed / auto-snapshot in this case).
 */
function handleProposalFailed({
  deps,
  payload,
}: SseEventContext<"proposal.failed">): void {
  const proposalType = (payload.proposalType as string) ?? "proposal";
  const error = (payload.error as string) ?? "commit failed";
  deps.dispatch({
    type: "SET_EXECUTION_ERROR",
    error: `${proposalType}: ${error}`,
  });
}

/**
 * Background failures the player did not ask about: no toast, but the bell
 * remembers them (and developer mode shows them as toasts).
 */
function handleQuietFailure({
  type,
  envelope,
  payload,
  turnId,
}: SseEventContext<
  | "hook.aborted"
  | "subagent.writes-dropped"
  | "gateway.failed"
  | "utils.fetch.failed"
  | "context.compaction.failed"
  | "commit.fanout.failed"
  | "command.failed"
>): void {
  pushNotice({
    key: `quiet:${type}:${turnId ?? ""}`,
    kind: "toast",
    tone: "warning",
    quiet: true,
    scope: envelope.sessionId || "global",
    title: i18n.t(`notice.quiet.${type}`),
    detail: safeJson(payload),
  });
}

function handleJobStatusUpdated({
  deps,
  payload,
  turnId,
}: SseEventContext<"job-status.updated">): void {
  const jobId = runtimeJobCorrelationId(payload);
  const existing = deps.stateRef.current.executionSteps.find(
    (step) =>
      (jobId && step.jobId === jobId) ||
      (step.detached === true &&
        step.runtimeId === payload.runtimeId &&
        step.turnId === turnId),
  );
  const step = buildJobStatusExecutionStep(payload, existing, turnId);
  if (step) deps.dispatch({ type: "UPSERT_EXECUTION_STEP", step });
}

/**
 * How the action stream treats every protocol event. The type annotation
 * makes the table exhaustive over `CovelEventType`: adding a protocol event
 * without an entry here (or keeping an entry for a removed one) fails to
 * compile. Events the action stream deliberately does not render are listed
 * as `"ignored"` so each new event forces a conscious decision.
 */
export const SSE_EVENT_ROUTES: SseEventRouteTable = {
  "plugin.fault.counted": "ignored",
  "plugin.fault.latched": handlePluginFault,
  "plugin.fault.cleared": handlePluginFault,

  "narrative.completed": handleNarrativeCompleted,
  "output.draft": handleOutputDraft,
  "output.retracted": handleOutputDraft,
  "output.accepted": handleOutputDraft,
  "interaction.requested": handleInteractionRequested,
  "ui.rendered": handleUiRendered,

  "execution.started": handleExecutionStarted,
  "execution.advance": handleExecutionAdvance,
  "execution.round.completed": handleExecutionSettled,
  "execution.completed": handleExecutionSettled,
  "runtime.started": handleRuntimeStarted,
  "runtime.deferred": handleRuntimeDeferred,
  "runtime.completed": handleRuntimeCompleted,
  "runtime.failed": handleRuntimeFailed,
  "runtime.skipped": handleRuntimeSkipped,
  "job-status.updated": handleJobStatusUpdated,

  "llm.calling": handleExecutionProgress,
  "llm.responded": handleReasoning,
  "gateway.responded": handleReasoning,
  "tool.calling": handleExecutionProgress,
  "tool.completed": handleExecutionProgress,
  "tool.failed": handleExecutionProgress,
  "step.started": handleExecutionProgress,
  "step.completed": handleExecutionProgress,

  "turn.suspended": handleTurnSuspended,
  "turn.resumed": handleTurnResumed,

  "plugin-data.changed": handlePluginDataChanged,
  "dimensions.changed": handleDimensionsChanged,
  "dimensions.settlement.changed": handleDimensionsChanged,
  "character-schema.changed": handleCharacterSchemaChanged,
  "character.upserted": handleCharacterUpserted,
  "asset.generated": handleAssetGenerated,
  "asset.progress": handleAssetProgress,

  "error.occurred": handleErrorOccurred,
  "operation.failed": handleOperationFailed,
  "proposal.failed": handleProposalFailed,

  "hook.aborted": handleQuietFailure,
  "subagent.writes-dropped": handleQuietFailure,
  "gateway.failed": handleQuietFailure,
  "utils.fetch.failed": handleQuietFailure,
  "context.compaction.failed": handleQuietFailure,
  "commit.fanout.failed": handleQuietFailure,
  "command.failed": handleQuietFailure,

  // UI slot events are applied by the UI slot store before routing; one it
  // declines has no session-store state.
  "ui.slot.changed": "ignored",
  "ui.slot.preview": "ignored",
  "ui.slot.cleared": "ignored",
  // Projected server-side into ui.slot.preview; no direct client state.
  "domain-event.previewed": "ignored",
  "event.emitted": "ignored",
  "ui.part.update": "ignored",
  // The subscription channel refreshes the world record.
  "world.dimensions.changed": "ignored",
  "state.snapshot.created": "ignored",
  "session.forked": "ignored",
  "message.completed": "ignored",
  "block.emitted": "ignored",
  "hook.fired": "ignored",
  "hook.rewrote": "ignored",
  "plugin.service.completed": "ignored",
  // Command lifecycle is trace-only and never forwarded to this action stream.
  "command.invoked": "ignored",
  "command.completed": "ignored",
  // Recursive-runtime trace events: subscription-channel only.
  "recursive.calling": "ignored",
  "recursive.completed": "ignored",
  "recursive.failed": "ignored",
  // Sub-agent runs: trace-only.
  "subagent.started": "ignored",
  "subagent.completed": "ignored",
  "subagent.failed": "ignored",
  // Function-runtime trace events drive the /debug timeline through the
  // subscription channel / trace_events. gateway.calling is forwarded to the
  // action stream (llm.* parity) but, like llm.calling's reply, needs no state.
  "function.executing": "ignored",
  "function.completed": "ignored",
  "presentation.completed": "ignored",
  "gateway.calling": "ignored",
  // Plugin-utils provider-call trace: /debug only, same as gateway.*.
  "utils.fetch.calling": "ignored",
  "utils.fetch.responded": "ignored",
  // Prompt-budget prune trace: /debug reads it from trace_events.
  "context.pruned": "ignored",
};

/** Narrows a raw wire string to a protocol event type with a route. */
export function isRoutedEventType(type: string): type is CovelEventType {
  return Object.hasOwn(SSE_EVENT_ROUTES, type);
}

/** Runs the route for one event; `"ignored"` events do nothing. */
export function routeSseEvent<K extends CovelEventType>(
  context: SseEventContext<K>,
): void {
  const route: SseEventRoute<K> = SSE_EVENT_ROUTES[context.type];
  if (route !== "ignored") route(context);
}
