/**
 * Event bus — fan-out to onEmit subscribers with per-session replay buffer.
 * Optionally persists events to a DataStore for audit trail.
 *
 * Ring buffer design (RING_BUFFER_MAX = 1000 per session):
 * Enables SSE reconnection recovery — when a client disconnects and reconnects,
 * it passes `lastEventId` and receives missed events via `getEventsAfter()`.
 * Used by `/api/events/stream` (subscribe.ts) for the out-of-band SSE channel.
 * The primary `/api/actions` channel does not use replay (it's per-turn lifecycle).
 */

import type { CovelMessage, SubscriptionEvent } from "@covel/shared";
import type { DataStore, EventRecord } from "@covel/store";

export interface EventBus {
  /** Publish an event. */
  emit(message: CovelMessage): void;
  /** Get subscription events after a given sequence number for replay. */
  getEventsAfter(sessionId: string, afterSeq: number): SubscriptionEvent[];
  /** Register a callback for every emitted event (as SubscriptionEvent). Returns unsubscribe function. */
  onEmit(callback: (event: SubscriptionEvent) => void): () => void;
  /**
   * Await all in-flight audit-event persistence. `emit()` is intentionally
   * non-blocking (audit trail is best-effort; authoritative state is durably
   * committed via the commit pipeline). Call `flush()` at a durability barrier
   * — graceful shutdown, test teardown, or before asserting audit rows — to
   * ensure every emitted event has been persisted. No-op when there is no
   * store. Never rejects (per-event failures are already logged).
   */
  flush(): Promise<void>;
}

const RING_BUFFER_MAX = 1000;

export function createEventBus(store?: DataStore): EventBus {
  // ── Subscription infrastructure ────────────────────────────────
  // Per-session monotonic sequence counter
  const sessionSeqCounters = new Map<string, number>();
  // Per-session ring buffer of recent SubscriptionEvents
  const sessionEventBuffers = new Map<string, SubscriptionEvent[]>();
  // Global onEmit callbacks
  const emitCallbacks = new Set<(event: SubscriptionEvent) => void>();
  // In-flight audit-event persistence promises, awaited by flush().
  const pendingSaves = new Set<Promise<void>>();

  function nextSeq(sessionId: string): number {
    const current = sessionSeqCounters.get(sessionId) ?? 0;
    const next = current + 1;
    sessionSeqCounters.set(sessionId, next);
    return next;
  }

  function appendToBuffer(sessionId: string, event: SubscriptionEvent): void {
    let buffer = sessionEventBuffers.get(sessionId);
    if (!buffer) {
      buffer = [];
      sessionEventBuffers.set(sessionId, buffer);
    }
    buffer.push(event);
    // M3: Trim ring buffer to max size — use shift() instead of splice(0, n) for O(1) typical case
    while (buffer.length > RING_BUFFER_MAX) {
      buffer.shift();
    }
  }

  function persistEvent(message: CovelMessage): void {
    if (!store) return;

    const record: EventRecord = {
      id: message.id,
      sessionId: message.sessionId,
      type: message.type,
      topic: message.topic,
      payload: message.payload,
      targetRuntime: message.targetRuntime,
      turnId: message.turnId,
      createdAt: message.timestamp,
    };

    // Non-blocking: persistence is for the audit trail, not on the emit hot
    // path. The promise is tracked in `pendingSaves` so flush() can await a
    // durability barrier; per-event failures are logged, never thrown.
    const save = store
      .saveEvent(record)
      .catch((err) => {
        console.error(
          `[EventBus] Failed to persist event "${record.id}":`,
          err,
        );
      })
      .finally(() => {
        pendingSaves.delete(save);
      });
    pendingSaves.add(save);
  }

  const bus: EventBus = {
    emit(message: CovelMessage): void {
      // ── Subscription event creation ──────────────────────────
      const seq = nextSeq(message.sessionId);
      // Allow payload to carry explicit subscription topic/type overrides
      const payload = message.payload;
      const subTopic = (
        typeof payload._subTopic === "string"
          ? payload._subTopic
          : message.topic
      ) as SubscriptionEvent["topic"];
      const subType =
        typeof payload._subType === "string" ? payload._subType : message.topic;
      // Strip internal fields from the exposed payload
      const {
        _subTopic: _t,
        _subType: _s,
        ...cleanPayload
      } = payload as Record<string, unknown>;
      const subEvent: SubscriptionEvent = {
        id: String(seq),
        topic: subTopic,
        type: subType,
        sessionId: message.sessionId,
        timestamp: message.timestamp,
        payload: cleanPayload,
      };
      appendToBuffer(message.sessionId, subEvent);
      for (const cb of emitCallbacks) {
        try {
          cb(subEvent);
        } catch (err) {
          console.error("[EventBus] onEmit callback error:", err);
        }
      }

      // Persist to store for audit trail
      persistEvent(message);
    },

    getEventsAfter(sessionId: string, afterSeq: number): SubscriptionEvent[] {
      const buffer = sessionEventBuffers.get(sessionId);
      if (!buffer || buffer.length === 0) {
        return [];
      }
      return buffer.filter((event) => parseInt(event.id, 10) > afterSeq);
    },

    onEmit(callback: (event: SubscriptionEvent) => void): () => void {
      emitCallbacks.add(callback);
      return () => {
        emitCallbacks.delete(callback);
      };
    },

    async flush(): Promise<void> {
      // Snapshot: saves that settle during the await remove themselves from
      // the set via `finally`, which is safe while we await a copy.
      await Promise.all(pendingSaves);
    },
  };

  return bus;
}
