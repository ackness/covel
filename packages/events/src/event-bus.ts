/**
 * Event bus — fan-out to onEmit subscribers with per-session replay buffer.
 * Optionally persists events to a DataStore for audit trail.
 *
 * Ring buffer design (RING_BUFFER_MAX = 1000 per session):
 * Enables SSE reconnection recovery — when a client disconnects and reconnects,
 * it passes `lastEventId` and receives missed events via `getEventsAfter()`.
 * Used by `/api/events/stream` (subscribe.ts) for the out-of-band SSE channel.
 * The primary `/api/actions` channel does not use replay (it's per-turn lifecycle).
 *
 * Memory bounds (audit R-03):
 * - Per-session state (seq counter + ring buffer) is LRU-tracked with a global
 *   cap (MAX_TRACKED_SESSIONS) and an idle TTL (SESSION_IDLE_TTL_MS). After a
 *   session is evicted, `getEventsAfter()` returns `[]` and the seq counter
 *   restarts at 1 on the next emit — SSE clients treat an empty replay as
 *   "gap unknown" and fall back to a full state fetch.
 * - Audit-trail persistence runs through a bounded queue with a small
 *   concurrency cap; on overflow the oldest queued save is dropped with a
 *   rate-limited warning (the audit trail is best-effort — authoritative
 *   state is durably committed via the commit pipeline).
 *
 * Cross-pod fan-out (audit R-02):
 * An optional `EventBusTransport` (e.g. PG LISTEN/NOTIFY) mirrors emitted
 * events to sibling pods, which append them to their local buffers and
 * re-broadcast to their local SSE subscribers. Sequence numbers stay per-pod:
 * a `lastEventId` is only meaningful against the pod that issued it, so behind
 * a non-sticky load balancer replay may return `[]` — the client's full-fetch
 * fallback covers that. Single-process backends (memory/sqlite/idb) pass no
 * transport and keep pure in-process behavior.
 */

import type { CovelMessage, SubscriptionEvent } from "@covel/shared";
import type { DataStore, EventRecord } from "@covel/store";
import { RingBuffer } from "./ring-buffer.js";

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

/**
 * Cross-pod fan-out seam. Payloads are opaque JSON strings (transport frames)
 * produced and consumed by the event bus itself; a transport only moves bytes
 * between processes. Implementations must deliver a published payload to all
 * subscribed handlers — including handlers in the publishing process (PG
 * NOTIFY does this); the bus filters self-echo via an origin id.
 */
export interface EventBusTransport {
  publish(payload: string): void | Promise<void>;
  subscribe(handler: (payload: string) => void): void;
}

export interface EventBusOptions {
  readonly transport?: EventBusTransport;
}

// Exported so tests exercise the real limits instead of duplicating them.
export const RING_BUFFER_MAX = 1000;
export const MAX_TRACKED_SESSIONS = 256;
export const SESSION_IDLE_TTL_MS = 30 * 60_000;
export const PERSIST_MAX_IN_FLIGHT = 8;
export const PERSIST_QUEUE_MAX = 1000;

const DROP_WARN_INTERVAL_MS = 10_000;
// PG NOTIFY hard-fails payloads ≥ 8000 bytes; leave slack for frame overhead.
const MAX_TRANSPORT_INLINE_BYTES = 7500;

interface SessionState {
  seq: number;
  buffer: RingBuffer<SubscriptionEvent>;
  lastTouchedMs: number;
}

/**
 * Wire frame moved over the transport. Exactly one of `event` / `ref` is set:
 * `event` inlines the full SubscriptionEvent (small payloads); `ref` points at
 * a persisted EventRecord for oversize payloads (receivers re-fetch from the
 * shared store).
 */
interface TransportFrame {
  readonly origin: string;
  readonly event?: SubscriptionEvent;
  readonly ref?: { readonly sessionId: string; readonly eventId: string };
}

function buildSubscriptionEvent(
  sessionId: string,
  topic: string,
  rawPayload: Record<string, unknown>,
  timestamp: string,
  seq: number,
): SubscriptionEvent {
  // Allow payload to carry explicit subscription topic/type overrides,
  // stripped from the exposed payload.
  const subTopic = (
    typeof rawPayload._subTopic === "string" ? rawPayload._subTopic : topic
  ) as SubscriptionEvent["topic"];
  const subType =
    typeof rawPayload._subType === "string" ? rawPayload._subType : topic;
  const { _subTopic: _t, _subType: _s, ...cleanPayload } = rawPayload;
  return {
    id: String(seq),
    topic: subTopic,
    type: subType,
    sessionId,
    timestamp,
    payload: cleanPayload,
  };
}

function parseTransportFrame(payload: string): TransportFrame | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const frame = raw as Record<string, unknown>;
  if (typeof frame.origin !== "string") return undefined;
  if (frame.event !== undefined) {
    const e = frame.event as Record<string, unknown> | null;
    if (
      typeof e !== "object" ||
      e === null ||
      typeof e.sessionId !== "string" ||
      typeof e.topic !== "string" ||
      typeof e.type !== "string"
    ) {
      return undefined;
    }
    return raw as TransportFrame;
  }
  if (frame.ref !== undefined) {
    const r = frame.ref as Record<string, unknown> | null;
    if (
      typeof r !== "object" ||
      r === null ||
      typeof r.sessionId !== "string" ||
      typeof r.eventId !== "string"
    ) {
      return undefined;
    }
    return raw as TransportFrame;
  }
  return undefined;
}

export function createEventBus(
  store?: DataStore,
  options?: EventBusOptions,
): EventBus {
  // ── Subscription infrastructure ────────────────────────────────
  // Per-session state, ordered least-recently-touched first (touching a
  // session re-inserts it, so Map insertion order doubles as an LRU list).
  const sessions = new Map<string, SessionState>();
  // Global onEmit callbacks
  const emitCallbacks = new Set<(event: SubscriptionEvent) => void>();
  const transport = options?.transport;
  // Identifies this bus instance on the transport channel so we can drop
  // self-echoed frames (PG NOTIFY delivers to the notifying pod too).
  const originId = crypto.randomUUID();

  // ── Bounded persist queue (audit R-03) ─────────────────────────
  const persistQueue: Array<() => Promise<void>> = [];
  let persistInFlight = 0;
  const flushWaiters: Array<() => void> = [];
  let droppedSinceWarn = 0;
  let lastDropWarnMs = 0;

  function touchSession(sessionId: string): SessionState {
    const now = Date.now();
    // Lazy TTL sweep: expired entries cluster at the front of the LRU-ordered
    // map, so this stops at the first fresh entry — O(evicted) per call.
    for (const [id, s] of sessions) {
      if (now - s.lastTouchedMs <= SESSION_IDLE_TTL_MS) break;
      sessions.delete(id);
    }
    let state = sessions.get(sessionId);
    if (state) {
      sessions.delete(sessionId); // re-insert to refresh LRU position
    } else {
      state = {
        seq: 0,
        buffer: new RingBuffer<SubscriptionEvent>(RING_BUFFER_MAX),
        lastTouchedMs: now,
      };
    }
    state.lastTouchedMs = now;
    sessions.set(sessionId, state);
    // Global budget on tracked sessions: evict least-recently-touched.
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value as string;
      sessions.delete(oldest);
    }
    return state;
  }

  function broadcast(event: SubscriptionEvent): void {
    for (const cb of emitCallbacks) {
      try {
        cb(event);
      } catch (err) {
        console.error("[EventBus] onEmit callback error:", err);
      }
    }
  }

  function pump(): void {
    while (persistInFlight < PERSIST_MAX_IN_FLIGHT && persistQueue.length > 0) {
      const task = persistQueue.shift()!;
      persistInFlight += 1;
      // Tasks catch internally and never reject.
      void task().finally(() => {
        persistInFlight -= 1;
        if (persistQueue.length > 0) {
          pump();
        } else if (persistInFlight === 0) {
          for (const waiter of flushWaiters.splice(0)) waiter();
        }
      });
    }
  }

  function enqueuePersist(
    record: EventRecord,
    afterSave?: () => void | Promise<void>,
  ): void {
    if (persistQueue.length >= PERSIST_QUEUE_MAX) {
      // Drop-oldest: the audit trail is best-effort, and the newest events
      // are the ones a reconnecting observer most likely needs.
      persistQueue.shift();
      droppedSinceWarn += 1;
      const now = Date.now();
      if (now - lastDropWarnMs >= DROP_WARN_INTERVAL_MS) {
        console.warn(
          `[EventBus] persist queue full (${PERSIST_QUEUE_MAX}); dropped ${droppedSinceWarn} audit event(s) since last warning`,
        );
        lastDropWarnMs = now;
        droppedSinceWarn = 0;
      }
    }
    persistQueue.push(async () => {
      try {
        await store!.saveEvent(record);
        // Runs only after a successful save — a transport `ref` frame is
        // useless if the record never reached the store.
        if (afterSave) await afterSave();
      } catch (err) {
        console.error(
          `[EventBus] Failed to persist event "${record.id}":`,
          err,
        );
      }
    });
    pump();
  }

  function publishToTransport(payload: string): void {
    void Promise.resolve(transport!.publish(payload)).catch((err) => {
      console.error("[EventBus] transport publish failed:", err);
    });
  }

  /** Append a remote event to local state with a locally-assigned seq. */
  function deliverRemote(remote: SubscriptionEvent): void {
    const state = touchSession(remote.sessionId);
    state.seq += 1;
    const event: SubscriptionEvent = { ...remote, id: String(state.seq) };
    state.buffer.push(event);
    broadcast(event);
  }

  async function handleTransportFrame(payload: string): Promise<void> {
    const frame = parseTransportFrame(payload);
    if (!frame) {
      console.warn("[EventBus] ignoring malformed transport frame");
      return;
    }
    if (frame.origin === originId) return; // self-echo
    if (frame.event) {
      deliverRemote(frame.event);
      return;
    }
    if (frame.ref) {
      if (!store) return; // cannot re-fetch without a store
      // ponytail: listEvents has no by-id lookup — full-session scan is fine
      // while oversize (>7.5 KB) events stay rare; add a getEventById to
      // DataStore if they become common.
      const records = await store.listEvents(frame.ref.sessionId);
      const record = records.find((r) => r.id === frame.ref!.eventId);
      if (!record) {
        console.warn(
          `[EventBus] transport ref "${frame.ref.eventId}" not found in store`,
        );
        return;
      }
      const rawPayload =
        typeof record.payload === "object" && record.payload !== null
          ? (record.payload as Record<string, unknown>)
          : {};
      const state = touchSession(record.sessionId);
      state.seq += 1;
      const event = buildSubscriptionEvent(
        record.sessionId,
        record.topic,
        rawPayload,
        record.createdAt,
        state.seq,
      );
      state.buffer.push(event);
      broadcast(event);
    }
  }

  if (transport) {
    transport.subscribe((payload) => {
      void handleTransportFrame(payload).catch((err) => {
        console.error("[EventBus] transport frame handling failed:", err);
      });
    });
  }

  const bus: EventBus = {
    emit(message: CovelMessage): void {
      // ── Subscription event creation ──────────────────────────
      const state = touchSession(message.sessionId);
      state.seq += 1;
      const subEvent = buildSubscriptionEvent(
        message.sessionId,
        message.topic,
        message.payload,
        message.timestamp,
        state.seq,
      );
      state.buffer.push(subEvent);
      broadcast(subEvent);

      // ── Cross-pod fan-out ────────────────────────────────────
      let afterSave: (() => void | Promise<void>) | undefined;
      if (transport) {
        const frame = JSON.stringify({
          origin: originId,
          event: subEvent,
        } satisfies TransportFrame);
        if (
          new TextEncoder().encode(frame).length <= MAX_TRANSPORT_INLINE_BYTES
        ) {
          publishToTransport(frame);
        } else if (store) {
          // Oversize: send a ref after the record is durably saved; sibling
          // pods re-fetch the payload from the shared store.
          const refFrame = JSON.stringify({
            origin: originId,
            ref: { sessionId: message.sessionId, eventId: message.id },
          } satisfies TransportFrame);
          afterSave = () => transport.publish(refFrame);
        } else {
          console.warn(
            `[EventBus] event "${message.id}" too large for transport and no store to ref — not fanned out cross-pod`,
          );
        }
      }

      // Persist to store for audit trail (non-blocking, bounded queue).
      if (store) {
        enqueuePersist(
          {
            id: message.id,
            sessionId: message.sessionId,
            type: message.type,
            topic: message.topic,
            payload: message.payload,
            targetRuntime: message.targetRuntime,
            turnId: message.turnId,
            createdAt: message.timestamp,
          },
          afterSave,
        );
      }
    },

    getEventsAfter(sessionId: string, afterSeq: number): SubscriptionEvent[] {
      const state = sessions.get(sessionId);
      // Unknown OR evicted session — the SSE client treats an empty replay
      // as "gap unknown" and falls back to a full state fetch.
      if (!state) return [];
      // Refresh LRU position: a replaying session is an active one.
      state.lastTouchedMs = Date.now();
      sessions.delete(sessionId);
      sessions.set(sessionId, state);
      return state.buffer
        .toArray()
        .filter((event) => parseInt(event.id, 10) > afterSeq);
    },

    onEmit(callback: (event: SubscriptionEvent) => void): () => void {
      emitCallbacks.add(callback);
      return () => {
        emitCallbacks.delete(callback);
      };
    },

    async flush(): Promise<void> {
      if (persistInFlight === 0 && persistQueue.length === 0) return;
      await new Promise<void>((resolve) => {
        flushWaiters.push(resolve);
      });
    },
  };

  return bus;
}
