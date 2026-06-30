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
import type { CovelEventType } from "@covel/shared";

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
}

export function createTurnEmitter(opts: CreateTurnEmitterOptions): TurnEmitter {
  let seq = 0;
  const traceId = opts.traceId ?? opts.turnId;

  return {
    sessionId: opts.sessionId,
    turnId: opts.turnId,
    async emit(type, payload) {
      // flowId mirrors traceId (protocol.md: `flowId = traceId`) so the
      // /api/traces payload carries a populated correlation id instead of "".
      // A payload that already sets flowId wins (spread after).
      const enriched = { flowId: traceId, ...payload, seq: seq++ };
      const createdAt = new Date().toISOString();

      const persist = opts.store
        .addTraceEvent({
          id: crypto.randomUUID(),
          sessionId: opts.sessionId,
          type,
          traceId,
          turnId: opts.turnId,
          payload: enriched,
          createdAt,
        })
        .catch((err: unknown) => {
          console.warn(
            `[turn-emitter] persist failed for type=${type}:`,
            err instanceof Error ? err.message : String(err),
          );
        });

      if (opts.eventBus) {
        try {
          opts.eventBus.emit({
            id: crypto.randomUUID(),
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
        } catch (err) {
          console.warn(
            `[turn-emitter] broadcast failed for type=${type}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      await persist;
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
