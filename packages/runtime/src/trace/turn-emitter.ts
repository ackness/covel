/**
 * TurnEmitter — per-turn trace fan-out.
 *
 * Each emit() call does two things:
 *   1. Persists a row into trace_events (via store.addTraceEvent).
 *   2. Broadcasts an eventBus event so the actions SSE stream picks it up.
 *
 * Created once per turn in actions.ts (alongside createTraceRecorder) and
 * threaded down through ToolCallContext / RuntimeContextView / HookContext /
 * llm.generate params. When absent (tests, third-party direct consumers),
 * emit() is never called and all subsystems degrade gracefully — callers
 * guard with `if (emitter) emitter.emit(...)` or use the provided no-op.
 */

import type { EventBus } from "@covel/events";
import {
  concealTracePayload,
  type CovelEventType,
  type RuntimeRetryScope,
} from "@covel/shared";

export interface TurnEmitterStore {
  addTraceEvent(record: {
    id: string;
    sessionId: string;
    type: string;
    traceId: string;
    turnId: string;
    payload: unknown;
    createdAt: string;
  }): Promise<void>;
}

export interface TurnEmitter {
  readonly sessionId: string;
  readonly turnId: string;
  /**
   * The correlation id this emitter stamps on persisted trace_events —
   * the SSE stream's traceId when the caller provided one, else the turnId.
   * Exposed so downstream writers (commit pipeline, trace recorder) can use
   * the SAME id instead of re-deriving from turnId — otherwise a turn's
   * rows land under two correlation ids and /debug shows a split timeline.
   */
  readonly traceId?: string;
  /**
   * Emit a trace event. `type` is constrained to the closed `CovelEventType`
   * union so a framework emit site cannot invent a name that is absent from the
   * protocol contract (and therefore from the action-stream forwarding
   * whitelist / frontend exhaustiveness). Plugin-authored custom events do NOT
   * flow through here — they ride the `event.emitted` commit event, whose
   * arbitrary topic/type lives in the payload as data, not as a wire event
   * name.
   */
  emit(type: CovelEventType, payload: Record<string, unknown>): Promise<void>;
}

export interface CreateTurnEmitterOptions {
  readonly store: TurnEmitterStore;
  readonly eventBus?: EventBus;
  readonly sessionId: string;
  readonly turnId: string;
  readonly traceId?: string;
  readonly retryScope?: RuntimeRetryScope;
  /**
   * Runtimes declared `io.concealed`. Their events lose every content field
   * before they are persisted or streamed, so no trace consumer can read them.
   */
  readonly concealedRuntimeIds?: ReadonlySet<string>;
}

export function createTurnEmitter(opts: CreateTurnEmitterOptions): TurnEmitter {
  let seq = 0;
  const traceId = opts.traceId ?? opts.turnId;

  return {
    sessionId: opts.sessionId,
    turnId: opts.turnId,
    traceId,
    async emit(type, payload) {
      // flowId mirrors traceId (protocol.md: `flowId = traceId`) so the
      // /api/traces payload carries a populated correlation id instead of "".
      // A payload that already sets flowId wins (spread after).
      const concealed =
        typeof payload.runtimeId === "string" &&
        opts.concealedRuntimeIds?.has(payload.runtimeId) === true;
      const full = {
        flowId: traceId,
        ...payload,
        ...opts.retryScope,
        seq: seq++,
      };
      const enriched = concealed ? concealTracePayload(full) : full;
      const createdAt = new Date().toISOString();
      const eventId = crypto.randomUUID();

      // Invoke inside the guard: adapters may throw before returning a promise.
      // Persist first so an oversized cross-process frame can reference this row.
      const persist = (async () => {
        try {
          await opts.store.addTraceEvent({
            id: eventId,
            sessionId: opts.sessionId,
            type,
            traceId,
            turnId: opts.turnId,
            payload: enriched,
            createdAt,
          });
        } catch {
          console.warn("[turn-emitter] persistence failed", {
            type,
            sessionId: opts.sessionId,
            turnId: opts.turnId,
            traceId,
          });
        }
      })();

      await persist;
      if (opts.eventBus) {
        try {
          opts.eventBus.emit({
            id: eventId,
            type: "event",
            topic: "trace",
            sessionId: opts.sessionId,
            timestamp: createdAt,
            payload: {
              _subTopic: "trace",
              _subType: type,
              sessionId: opts.sessionId,
              turnId: opts.turnId,
              ...enriched,
            },
          });
        } catch {
          console.warn("[turn-emitter] broadcast failed", {
            type,
            sessionId: opts.sessionId,
            turnId: opts.turnId,
            traceId,
          });
        }
      }
    },
  };
}

/** No-op emitter for tests and third-party contexts that don't need trace. */
export function createNoopTurnEmitter(
  sessionId = "",
  turnId = "",
): TurnEmitter {
  return {
    sessionId,
    turnId,
    async emit() {
      /* no-op */
    },
  };
}
