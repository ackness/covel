import {
  isAssetGenerateView,
  PLAYER_ABORT_REASON,
  type CovelEventType,
} from "@covel/shared";
import * as api from "@/services/api";
import type { DataService } from "@/services/data-service.js";
import { ignoreError } from "@/lib/ignore-error.js";
import {
  appendStreamingText,
  clearStreamingText,
  clearStreamingTextsForTurn,
} from "@/stores/streaming-text-store.js";
import {
  reducePluginDataChanged,
  reduceTurnResumed,
  reduceTurnSuspended,
} from "./event-reducers.js";
import { createExecutionStepUpdate } from "./execution-steps.js";
import { upsertGameStateCharacter } from "./game-state.js";
import type {
  AssetProgressEvent,
  ExecutionStep,
  SessionAction,
  SessionState,
  SnapshotCharacter,
  StreamMessage,
} from "./types.js";

interface MutableRef<T> {
  current: T;
}

interface DeltaBufferEntry {
  turnId: string;
  runtimeId: string;
  pluginId: string;
  text: string;
  flushSessionId: string | null;
}

export type DeltaBufferRef = MutableRef<Map<string, DeltaBufferEntry>>;
export type DeltaRafRef = MutableRef<number | null>;

export interface SseEventHandlerDeps {
  dispatch: (action: SessionAction) => void;
  ds: DataService;
  sessionIdRef: MutableRef<string | null>;
  stateRef: MutableRef<SessionState>;
  runtimeKindRef: MutableRef<Map<string, string>>;
  deltaBufferRef: DeltaBufferRef;
  deltaRafRef: DeltaRafRef;
  lastBackfilledTurnIdRef: MutableRef<string | null>;
}

export type SseEventHandler = (envelope: api.SseEnvelope) => void;

export function clearNarrativeDeltaBuffer(
  deltaBufferRef: DeltaBufferRef,
  deltaRafRef: DeltaRafRef,
): void {
  if (deltaRafRef.current !== null) {
    cancelAnimationFrame(deltaRafRef.current);
    deltaRafRef.current = null;
  }
  deltaBufferRef.current.clear();
}

function queueNarrativeDelta(
  deps: Pick<
    SseEventHandlerDeps,
    "dispatch" | "sessionIdRef" | "deltaBufferRef" | "deltaRafRef"
  >,
  entry: {
    turnId: string | undefined;
    runtimeId: string;
    pluginId: string;
    delta: string;
  },
): void {
  const turnId = entry.turnId ?? "unknown";
  const bufKey = `${turnId}_${entry.runtimeId}`;
  const existing = deps.deltaBufferRef.current.get(bufKey);
  if (existing) {
    existing.text += entry.delta;
  } else {
    deps.deltaBufferRef.current.set(bufKey, {
      turnId,
      runtimeId: entry.runtimeId,
      pluginId: entry.pluginId,
      text: entry.delta,
      flushSessionId: deps.sessionIdRef.current,
    });
  }
  if (deps.deltaRafRef.current !== null) return;

  deps.deltaRafRef.current = requestAnimationFrame(() => {
    flushNarrativeDeltaBuffer(deps);
  });
}

function flushNarrativeDeltaBuffer(
  deps: Pick<
    SseEventHandlerDeps,
    "dispatch" | "sessionIdRef" | "deltaBufferRef" | "deltaRafRef"
  >,
): void {
  if (deps.deltaRafRef.current !== null) {
    cancelAnimationFrame(deps.deltaRafRef.current);
    deps.deltaRafRef.current = null;
  }
  const bufferedEntries = [...deps.deltaBufferRef.current.values()];
  deps.deltaBufferRef.current.clear();
  const currentSid = deps.sessionIdRef.current;
  for (const buffered of bufferedEntries) {
    if (buffered.flushSessionId !== currentSid) continue;
    const streamId = `stream_${buffered.turnId}_${buffered.runtimeId}`;
    const firstChunk = appendStreamingText(streamId, buffered.text);
    if (!firstChunk) continue;
    deps.dispatch({
      type: "APPEND_DELTA",
      turnId: buffered.turnId,
      runtimeId: buffered.runtimeId,
      pluginId: buffered.pluginId,
      delta: buffered.text,
    });
  }
}

function addBlockMessageFromSse(
  deps: Pick<SseEventHandlerDeps, "dispatch" | "ds" | "sessionIdRef">,
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
  const sid = deps.sessionIdRef.current;
  if (sid) {
    deps.ds
      .addMessage({
        id: blockId,
        sessionId: sid,
        role: "assistant",
        content: "",
        turnId: blockTurnId,
        runtimeId,
        kind: "plugin",
        block,
        createdAt: timestamp,
      })
      .catch(ignoreError("persist block message"));
  }
}

function toRuntimeCompletedStatus(rawStatus: unknown): ExecutionStep["status"] {
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
    // `SseEnvelope.type` is the raw, untrusted wire string. Narrow it to the
    // closed `CovelEventType` union so the switch below is exhaustiveness-
    // checked: every union member must be either handled or explicitly
    // ignored, and genuinely unknown wire strings fall through to
    // `assertNeverEvent` (warn — never silently dropped).
    const eventType: CovelEventType = envelope.type as CovelEventType;

    if (turnId && turnId !== deps.lastBackfilledTurnIdRef.current) {
      deps.lastBackfilledTurnIdRef.current = turnId;
      deps.dispatch({ type: "BACKFILL_TURN_ID", turnId });
    }

    switch (eventType) {
      case "narrative.delta": {
        const delta = (payload.delta as string) ?? "";
        const runtimeId = (payload.runtimeId as string) ?? "unknown";
        const pluginId = (payload.pluginId as string) ?? "";
        const deltaKind =
          (payload.kind as string) ??
          deps.runtimeKindRef.current.get(runtimeId);
        if (delta && deltaKind === "story") {
          queueNarrativeDelta(deps, { turnId, runtimeId, pluginId, delta });
        }
        break;
      }
      case "narrative.completed": {
        const content = (payload.content as string) ?? "";
        const runtimeId = (payload.runtimeId as string) ?? "unknown";
        const msgId = (payload.messageId as string) ?? crypto.randomUUID();
        const completedKind =
          (payload.kind as string) ??
          deps.runtimeKindRef.current.get(runtimeId);
        if (completedKind === "story") {
          // A story runtime's stream is finished. Always flush the same-frame
          // delta and drop the external live buffer — even on empty content —
          // so stale partial text can't linger on screen (audit 2026-07-16
          // L-11). Only publish an authoritative message when content exists.
          flushNarrativeDeltaBuffer(deps);
          clearStreamingText(`stream_${turnId ?? "unknown"}_${runtimeId}`);
          if (content) {
            const msg: StreamMessage = {
              id: msgId,
              role: "assistant",
              content,
              timestamp: envelope.timestamp,
              turnId,
              runtimeId: runtimeId !== "unknown" ? runtimeId : undefined,
            };
            deps.dispatch({
              type: "COMPLETE_MESSAGE",
              turnId: turnId ?? "unknown",
              runtimeId,
              message: msg,
            });
          }
        }

        if (content) {
          const sid = deps.sessionIdRef.current;
          if (sid) {
            deps.ds
              .addMessage({
                id: msgId,
                sessionId: sid,
                role: "assistant",
                content,
                turnId,
                runtimeId: runtimeId !== "unknown" ? runtimeId : undefined,
                kind: completedKind,
                createdAt: envelope.timestamp,
              })
              .catch(ignoreError("persist narrative message"));
          }
        }
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
        const block = payload.block as Record<string, unknown> | undefined;
        const render = payload.render as Record<string, unknown> | undefined;
        const uiBlock =
          block ??
          (render
            ? {
                id:
                  (payload.proposalId as string | undefined) ??
                  crypto.randomUUID(),
                type: "ui.render",
                data: render,
                meta: {
                  runtimeId: payload.runtimeId,
                  pluginId: payload.pluginId,
                  turnId: (payload.turnId as string | undefined) ?? turnId,
                },
              }
            : null);
        if (uiBlock) {
          addBlockMessageFromSse(
            deps,
            uiBlock,
            payload,
            envelope.timestamp,
            turnId,
          );
        }
        break;
      }
      case "state.changed": {
        const table = payload.table as string | undefined;
        const field = payload.field as string | undefined;
        const value = payload.value;
        const patch = {
          id: `sp_${Date.now()}`,
          summary: field ? `${table ?? "default"}.${field}` : "state change",
          packageName: (payload.pluginId as string) ?? "system",
          data: field ? { [field]: value } : undefined,
        };

        deps.dispatch({ type: "ADD_STATE_PATCH", patch });
        const sid = deps.sessionIdRef.current;
        if (sid) {
          deps.ds
            .addStatePatch(sid, {
              ...patch,
              sessionId: sid,
              createdAt: new Date().toISOString(),
            })
            .catch(ignoreError("persist state patch"));
        }
        break;
      }
      case "execution.started":
        break;
      case "runtime.started": {
        const runtimeId = (payload.runtimeId as string) ?? "unknown";
        const pluginId = (payload.pluginId as string) ?? "";
        const label = payload.label as string | undefined;
        let kind = payload.kind as string | undefined;
        if (!kind && label) {
          const slashIdx = label.indexOf("/");
          if (slashIdx >= 0) kind = label.slice(slashIdx + 1);
        }
        if (kind) deps.runtimeKindRef.current.set(runtimeId, kind);
        deps.dispatch({
          type: "UPSERT_EXECUTION_STEP",
          step: {
            runtimeId,
            pluginId,
            status: "running",
            label,
            turnId,
            startedAt: envelope.timestamp,
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
      case "execution.completed": {
        // A turn aborted before producing output (e.g. cost-gate's hard budget
        // cap) carries an abortReason — surface it so the player isn't left with
        // a silent empty turn. A player-initiated abort is NOT an error: the
        // server never commits the partial narrative, so discard the streaming
        // placeholder instead of showing ghost text + a red retry affordance.
        const abortReason = payload.abortReason as string | undefined;
        if (abortReason === PLAYER_ABORT_REASON) {
          // Cancel any pending rAF delta flush + drop buffered deltas first:
          // otherwise a fast abort (last narrative.delta + execution.completed
          // in one network flush) lets the queued rAF fire AFTER the discard
          // and re-`APPEND_DELTA` the ghost placeholder back into view.
          clearNarrativeDeltaBuffer(deps.deltaBufferRef, deps.deltaRafRef);
          if (turnId) clearStreamingTextsForTurn(turnId);
          deps.dispatch({
            type: "DISCARD_TURN_STREAMS",
            ...(turnId ? { turnId } : {}),
          });
        } else if (abortReason) {
          deps.dispatch({ type: "SET_EXECUTION_ERROR", error: abortReason });
        }
        deps.dispatch({ type: "SET_EXECUTING", value: false });
        deps.dispatch({
          type: "FINALIZE_HANGING_RUNTIMES",
          reason: "__i18n:session.reasonConnectionClosed__",
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
      case "event.emitted": {
        const topic = (payload.topic as string) ?? (payload.type as string);
        const eventData = payload.data ?? payload;
        if (topic) {
          deps.dispatch({
            type: "ADD_STATE_PATCH",
            patch: {
              id: `evt_${Date.now()}`,
              summary: `event: ${topic}`,
              packageName: (payload.pluginId as string) ?? "system",
              data: {
                events: [
                  {
                    id: `evt_${Date.now()}`,
                    title: topic,
                    type: (payload.eventType as string) ?? topic,
                    status: "active",
                    description:
                      typeof eventData === "object"
                        ? JSON.stringify(eventData)
                        : String(eventData),
                    turnCreated: turnId
                      ? parseInt(turnId.split("-").pop() ?? "0", 10)
                      : undefined,
                  },
                ],
              },
            },
          });
        }
        break;
      }
      case "plugin-data.changed": {
        reducePluginDataChanged(deps.dispatch, payload);
        break;
      }
      case "character.upserted": {
        const character = payload.character;
        if (character && typeof character === "object") {
          deps.dispatch({
            type: "SET_GAME_STATE",
            state: upsertGameStateCharacter(
              deps.stateRef.current.gameState,
              character as SnapshotCharacter,
            ),
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
        deps.dispatch({
          type: "SET_EXECUTION_ERROR",
          error: (payload.message as string) ?? "Execution failed",
        });
        deps.dispatch({ type: "SET_EXECUTING", value: false });
        deps.dispatch({
          type: "FINALIZE_HANGING_RUNTIMES",
          reason: "__i18n:session.reasonConnectionClosed__",
        });
        break;
      }
      // Known CovelEvents that the action-stream handler intentionally does
      // NOT render: runtime-internal trace events forwarded onto this stream
      // (consumed by the /debug timeline via the subscription channel) plus
      // reserved lifecycle events handled elsewhere. Listed explicitly so the
      // `assertNeverEvent` exhaustiveness guard below stays green — adding a
      // new CovelEvent forces a conscious decision here (handle or ignore).
      case "interaction.completed":
      case "ui.part.update":
      case "state.snapshot":
      case "state.patch.applied":
      case "record.updated":
      case "world.dimensions.changed":
      case "connection.restored":
      case "state.snapshot.created":
      case "session.forked":
      // `working_memory.changed` rides the action stream as a commit event but
      // is intentionally not rendered here — the UI reflects working-memory
      // mutations via `state.changed`. Explicit so the exhaustiveness guard
      // stays green (previously this fell through to `assertNeverEvent` and
      // warned on every commit).
      case "working_memory.changed":
      case "tool.calling":
      case "tool.completed":
      case "tool.failed":
      case "llm.calling":
      case "llm.responded":
      case "message.completed":
      case "block.emitted":
      case "hook.fired":
      case "hook.rewrote":
      case "hook.aborted":
      // Recursive-runtime trace events: subscription-channel only, never
      // forwarded to this action stream — listed for exhaustiveness only.
      case "recursive.calling":
      case "recursive.completed":
      case "recursive.failed":
      // Function-runtime trace events: drive the /debug timeline via the
      // subscription channel / trace_events, not this action renderer.
      // gateway.* forward to the action stream (llm.* parity) but the action
      // handler ignores them here, same as tool.*/llm.*.
      case "function.executing":
      case "function.completed":
      case "gateway.calling":
      case "gateway.responded":
      case "gateway.failed":
      // Plugin-utils provider-call trace (A2-P1-5): /debug-only, same as gateway.*
      case "utils.fetch.calling":
      case "utils.fetch.responded":
      case "utils.fetch.failed":
        break;
      default:
        assertNeverEvent(eventType);
    }
  };
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
