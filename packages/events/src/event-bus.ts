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
 * Epochs + gap detection (re-review H-05/H-06):
 * Every session replay state carries an `epoch` minted when the state is
 * (re)created; wire event ids are `${epoch}:${seq}` so ids are never reused
 * across eviction or process restart. `getEventsAfter()` reports `gap: true`
 * whenever it cannot bridge the caller's cursor (unknown/evicted session,
 * ring wrapped past the cursor, cursor ahead of the counter) — the SSE layer
 * translates that into a `system.reset` control frame. `pin()` keeps a
 * session's state out of LRU/TTL eviction while it has active subscribers.
 *
 * Memory bounds (audit R-03):
 * - Per-session state (seq counter + ring buffer) is LRU-tracked with a global
 *   cap (MAX_TRACKED_SESSIONS) and an idle TTL (SESSION_IDLE_TTL_MS); pinned
 *   sessions are exempt (their count is bounded by the SSE connection caps).
 * - Audit-trail persistence runs through a bounded queue with a small
 *   concurrency cap; on overflow the oldest queued save is dropped with a
 *   rate-limited warning (the audit trail is best-effort — authoritative
 *   state is durably committed via the commit pipeline).
 *
 * Cross-pod fan-out (audit R-02, re-review H-07):
 * An optional `EventBusTransport` (e.g. PG LISTEN/NOTIFY) mirrors emitted
 * events to sibling pods. Frames carry the origin's per-session seq and are
 * published through a per-session serialized outbox (an oversize event's ref
 * frame publishes only after its store save settles, and later frames for the
 * same session queue behind it), so a single origin's frames leave in seq
 * order. Receivers additionally order-buffer by (origin, session, seq) before
 * delivering, re-fetch oversize refs via `store.getEventById`, and assign
 * their own local `${epoch}:${seq}` ids — a cursor is only meaningful against
 * the pod that issued it; a non-sticky reconnect lands on a different epoch
 * and triggers a client reset. Remaining durability boundary: if an oversize
 * event's persist is dropped (queue overflow) or fails, its seq becomes a hole
 * cross-pod — receivers skip it after RECEIVE_GAP_FLUSH_MS instead of stalling.
 */

import type { CovelMessage, SubscriptionEvent } from "@covel/shared";
import type { DataStore, EventRecord } from "@covel/store";
import { RingBuffer } from "./ring-buffer.js";

/** Result of a replay query — `gap` means the cursor could not be bridged. */
export interface EventReplay {
  /** Retained events with seq > afterSeq, oldest → newest. */
  readonly events: SubscriptionEvent[];
  /**
   * True when replay is incomplete: session untracked (unknown or evicted),
   * ring buffer wrapped past `afterSeq`, or `afterSeq` is ahead of the latest
   * issued seq. The subscriber must tell its client to reset and re-hydrate.
   */
  readonly gap: boolean;
  /** Current epoch of the session state; undefined when untracked. */
  readonly epoch: string | undefined;
  /** Oldest retained seq (0 when nothing is retained). */
  readonly oldestSeq: number;
  /** Latest issued seq (0 when no events have been emitted this epoch). */
  readonly latestSeq: number;
}

/** Handle returned by {@link EventBus.pin}. */
export interface SessionPin {
  /** Epoch of the pinned session state (stable while the pin is held). */
  readonly epoch: string;
  /** Release the pin. Idempotent. */
  release(): void;
}

export interface EventBus {
  /** Publish an event. */
  emit(message: CovelMessage): void;
  /** Get subscription events after a given sequence number for replay. */
  getEventsAfter(sessionId: string, afterSeq: number): EventReplay;
  /**
   * Pin a session's replay state while it has an active subscriber: pinned
   * sessions are excluded from LRU/TTL eviction (H-06), so an open SSE stream
   * never observes its session's seq/epoch being reset mid-connection.
   */
  pin(sessionId: string): SessionPin;
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
/** Receive-side reorder buffer cap per (origin, session). */
export const RECEIVE_PENDING_MAX = 64;
/** How long a receiver waits on a transport seq hole before skipping it. */
export const RECEIVE_GAP_FLUSH_MS = 2000;

const DROP_WARN_INTERVAL_MS = 10_000;
// PG NOTIFY hard-fails payloads ≥ 8000 bytes; leave slack for frame overhead.
const MAX_TRANSPORT_INLINE_BYTES = 7500;
// ponytail: FIFO cap on receive-ordering states; oldest entry dropped when
// full — worst case one very late frame from that origin/session delivers out
// of order. Upgrade to LRU + per-entry TTL if multi-pod fleets ever grow.
const RECEIVE_STATES_MAX = 1024;

interface SessionState {
  seq: number;
  /** Changes every time this state is (re)created — wire ids never repeat. */
  epoch: string;
  /** Active subscriber count; > 0 exempts the state from eviction. */
  pinCount: number;
  buffer: RingBuffer<SubscriptionEvent>;
  lastTouchedMs: number;
}

/**
 * Wire frame moved over the transport. `seq` is the origin's per-session
 * sequence number (receivers order-buffer on it). Exactly one of `event` /
 * `ref` is set: `event` inlines the full SubscriptionEvent (small payloads);
 * `ref` points at a persisted EventRecord for oversize payloads (receivers
 * re-fetch from the shared store via `getEventById`).
 */
interface TransportFrame {
  readonly origin: string;
  readonly seq: number;
  readonly event?: SubscriptionEvent;
  readonly ref?: { readonly sessionId: string; readonly eventId: string };
}

/** Per-(origin, session) receive-side ordering state. */
interface ReceiveState {
  /** Next expected origin seq; undefined until the first frame arrives. */
  expected: number | undefined;
  /** Out-of-order frames parked until their predecessors arrive. */
  pending: Map<number, TransportFrame>;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Serialized delivery chain — ref re-fetches must not let later frames overtake. */
  chain: Promise<void>;
}

function buildSubscriptionEvent(
  sessionId: string,
  topic: string,
  rawPayload: Record<string, unknown>,
  timestamp: string,
  epoch: string,
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
    id: `${epoch}:${seq}`,
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
  if (typeof frame.seq !== "number" || !Number.isSafeInteger(frame.seq)) {
    return undefined;
  }
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
  // Epoch = `${busBootId}-${generation}`: the random prefix separates process
  // restarts, the counter separates session-state re-creations within one
  // process. Clients treat epochs as opaque strings and only compare equality.
  const epochPrefix = originId.slice(0, 8);
  let epochGeneration = 0;
  const nextEpoch = (): string => `${epochPrefix}-${++epochGeneration}`;

  // ── Bounded persist queue (audit R-03) ─────────────────────────
  interface PersistItem {
    readonly record: EventRecord;
    /** Always called exactly once: true after a successful save, false on error/drop. */
    readonly settle?: (ok: boolean) => void;
  }
  const persistQueue: PersistItem[] = [];
  let persistInFlight = 0;
  const flushWaiters: Array<() => void> = [];
  let droppedSinceWarn = 0;
  let lastDropWarnMs = 0;

  // ── Transport ordering state (re-review H-07) ──────────────────
  // Publisher: per-session promise chain so frames leave in seq order.
  const outboxTails = new Map<string, Promise<void>>();
  // Receiver: per-(origin, session) seq ordering + serialized delivery.
  const receiveStates = new Map<string, ReceiveState>();

  function touchSession(sessionId: string): SessionState {
    const now = Date.now();
    // Lazy TTL sweep: expired entries cluster at the front of the LRU-ordered
    // map, so this stops at the first fresh entry — O(evicted + pinned) per
    // call. Pinned sessions (active SSE subscribers) are skipped, not evicted.
    for (const [id, s] of sessions) {
      if (s.pinCount > 0) continue;
      if (now - s.lastTouchedMs <= SESSION_IDLE_TTL_MS) break;
      sessions.delete(id);
    }
    let state = sessions.get(sessionId);
    if (state) {
      sessions.delete(sessionId); // re-insert to refresh LRU position
    } else {
      state = {
        seq: 0,
        epoch: nextEpoch(),
        pinCount: 0,
        buffer: new RingBuffer<SubscriptionEvent>(RING_BUFFER_MAX),
        lastTouchedMs: now,
      };
    }
    state.lastTouchedMs = now;
    sessions.set(sessionId, state);
    // Global budget on tracked sessions: evict least-recently-touched,
    // skipping pinned states (the pin count is bounded by the SSE connection
    // caps, so the overshoot is small and temporary).
    if (sessions.size > MAX_TRACKED_SESSIONS) {
      for (const [id, s] of sessions) {
        if (sessions.size <= MAX_TRACKED_SESSIONS) break;
        if (s.pinCount > 0) continue;
        sessions.delete(id);
      }
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
      const item = persistQueue.shift()!;
      persistInFlight += 1;
      void runPersist(item).finally(() => {
        persistInFlight -= 1;
        if (persistQueue.length > 0) {
          pump();
        } else if (persistInFlight === 0) {
          for (const waiter of flushWaiters.splice(0)) waiter();
        }
      });
    }
  }

  async function runPersist(item: PersistItem): Promise<void> {
    try {
      await store!.saveEvent(item.record);
      item.settle?.(true);
    } catch (err) {
      console.error(
        `[EventBus] Failed to persist event "${item.record.id}":`,
        err,
      );
      item.settle?.(false);
    }
  }

  function enqueuePersist(item: PersistItem): void {
    if (persistQueue.length >= PERSIST_QUEUE_MAX) {
      // Drop-oldest: the audit trail is best-effort, and the newest events
      // are the ones a reconnecting observer most likely needs. Settling the
      // dropped item (false) unblocks any transport outbox waiting on it.
      const dropped = persistQueue.shift()!;
      dropped.settle?.(false);
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
    persistQueue.push(item);
    pump();
  }

  /**
   * Per-session serialized publish: each task runs after the previous one for
   * the same session settles, so inline frames cannot overtake an oversize
   * ref frame that is still waiting on its store save (H-07).
   */
  function enqueueOutbox(sessionId: string, task: () => Promise<void>): void {
    const tail = outboxTails.get(sessionId) ?? Promise.resolve();
    const next = tail.then(task).catch((err) => {
      console.error("[EventBus] transport publish failed:", err);
    });
    outboxTails.set(sessionId, next);
    void next.then(() => {
      // Drop the tail once idle so the map doesn't grow with session count.
      if (outboxTails.get(sessionId) === next) outboxTails.delete(sessionId);
    });
  }

  /** Append a remote event to local state with a locally-assigned epoch:seq id. */
  function deliverRemote(remote: SubscriptionEvent): void {
    const state = touchSession(remote.sessionId);
    state.seq += 1;
    const event: SubscriptionEvent = {
      ...remote,
      id: `${state.epoch}:${state.seq}`,
    };
    state.buffer.push(event);
    broadcast(event);
  }

  async function deliverFrame(frame: TransportFrame): Promise<void> {
    if (frame.event) {
      deliverRemote(frame.event);
      return;
    }
    if (!frame.ref) return;
    if (!store) return; // cannot re-fetch without a store
    const record = await store.getEventById(
      frame.ref.sessionId,
      frame.ref.eventId,
    );
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
      state.epoch,
      state.seq,
    );
    state.buffer.push(event);
    broadcast(event);
  }

  function getReceiveState(key: string): ReceiveState {
    let rs = receiveStates.get(key);
    if (!rs) {
      if (receiveStates.size >= RECEIVE_STATES_MAX) {
        const oldestKey = receiveStates.keys().next().value as string;
        const oldest = receiveStates.get(oldestKey);
        if (oldest?.timer) clearTimeout(oldest.timer);
        receiveStates.delete(oldestKey);
      }
      rs = {
        expected: undefined,
        pending: new Map(),
        timer: undefined,
        chain: Promise.resolve(),
      };
      receiveStates.set(key, rs);
    }
    return rs;
  }

  /** Queue a frame onto the per-key delivery chain (preserves seq order even across async ref re-fetches). */
  function scheduleDeliver(rs: ReceiveState, frame: TransportFrame): void {
    rs.chain = rs.chain
      .then(() => deliverFrame(frame))
      .catch((err) => {
        console.error("[EventBus] transport frame delivery failed:", err);
      });
  }

  /**
   * Seq-hole escape hatch: deliver everything parked (in seq order) and skip
   * the missing seq(s). Holes are real — an oversize event whose persist was
   * dropped never publishes its ref frame (documented durability boundary).
   */
  function flushPending(rs: ReceiveState): void {
    if (rs.timer) {
      clearTimeout(rs.timer);
      rs.timer = undefined;
    }
    if (rs.pending.size === 0) return;
    const seqs = [...rs.pending.keys()].sort((a, b) => a - b);
    console.warn(
      `[EventBus] transport seq gap (expected ${rs.expected}, buffered from ${seqs[0]}) — delivering ${seqs.length} buffered frame(s), skipping the hole`,
    );
    for (const seq of seqs) {
      scheduleDeliver(rs, rs.pending.get(seq)!);
    }
    rs.expected = seqs[seqs.length - 1]! + 1;
    rs.pending.clear();
  }

  function handleTransportFrame(payload: string): void {
    const frame = parseTransportFrame(payload);
    if (!frame) {
      console.warn("[EventBus] ignoring malformed transport frame");
      return;
    }
    if (frame.origin === originId) return; // self-echo
    const sessionId = frame.event?.sessionId ?? frame.ref!.sessionId;
    const rs = getReceiveState(`${frame.origin} ${sessionId}`);
    if (rs.expected !== undefined && frame.seq < rs.expected) return; // duplicate/late
    if (rs.expected === undefined || frame.seq === rs.expected) {
      scheduleDeliver(rs, frame);
      rs.expected = frame.seq + 1;
      // Drain any parked successors that are now consecutive.
      while (rs.pending.has(rs.expected)) {
        scheduleDeliver(rs, rs.pending.get(rs.expected)!);
        rs.pending.delete(rs.expected);
        rs.expected += 1;
      }
      if (rs.pending.size === 0 && rs.timer) {
        clearTimeout(rs.timer);
        rs.timer = undefined;
      }
      return;
    }
    // Out of order: park until predecessors arrive, bounded by cap + timer.
    rs.pending.set(frame.seq, frame);
    if (rs.pending.size > RECEIVE_PENDING_MAX) {
      flushPending(rs);
    } else if (!rs.timer) {
      rs.timer = setTimeout(() => flushPending(rs), RECEIVE_GAP_FLUSH_MS);
    }
  }

  if (transport) {
    transport.subscribe(handleTransportFrame);
  }

  const bus: EventBus = {
    emit(message: CovelMessage): void {
      // ── Subscription event creation ──────────────────────────
      const state = touchSession(message.sessionId);
      state.seq += 1;
      const seq = state.seq;
      const subEvent = buildSubscriptionEvent(
        message.sessionId,
        message.topic,
        message.payload,
        message.timestamp,
        state.epoch,
        seq,
      );
      state.buffer.push(subEvent);
      broadcast(subEvent);

      // ── Cross-pod fan-out (per-session serialized outbox, H-07) ──
      let persistSettle: ((ok: boolean) => void) | undefined;
      if (transport) {
        const frame = JSON.stringify({
          origin: originId,
          seq,
          event: subEvent,
        } satisfies TransportFrame);
        if (
          new TextEncoder().encode(frame).length <= MAX_TRANSPORT_INLINE_BYTES
        ) {
          enqueueOutbox(message.sessionId, () =>
            Promise.resolve(transport.publish(frame)),
          );
        } else if (store) {
          // Oversize: send a ref after the record is durably saved; sibling
          // pods re-fetch the payload from the shared store. Later frames for
          // this session queue behind the save so seq order is preserved.
          const refFrame = JSON.stringify({
            origin: originId,
            seq,
            ref: { sessionId: message.sessionId, eventId: message.id },
          } satisfies TransportFrame);
          let settle!: (ok: boolean) => void;
          const saved = new Promise<boolean>((resolve) => {
            settle = resolve;
          });
          persistSettle = settle;
          enqueueOutbox(message.sessionId, async () => {
            if (await saved) {
              await transport.publish(refFrame);
            } else {
              console.warn(
                `[EventBus] oversize event "${message.id}" was not persisted — cross-pod fan-out skipped (seq ${seq} becomes a hole)`,
              );
            }
          });
        } else {
          console.warn(
            `[EventBus] event "${message.id}" too large for transport and no store to ref — not fanned out cross-pod`,
          );
        }
      }

      // Persist to store for audit trail (non-blocking, bounded queue).
      if (store) {
        enqueuePersist({
          record: {
            id: message.id,
            sessionId: message.sessionId,
            type: message.type,
            topic: message.topic,
            payload: message.payload,
            targetRuntime: message.targetRuntime,
            turnId: message.turnId,
            createdAt: message.timestamp,
          },
          settle: persistSettle,
        });
      }
    },

    getEventsAfter(sessionId: string, afterSeq: number): EventReplay {
      const state = sessions.get(sessionId);
      // Unknown OR evicted session — the cursor cannot be bridged (H-05).
      if (!state) {
        return {
          events: [],
          gap: true,
          epoch: undefined,
          oldestSeq: 0,
          latestSeq: 0,
        };
      }
      // Refresh LRU position: a replaying session is an active one.
      state.lastTouchedMs = Date.now();
      sessions.delete(sessionId);
      sessions.set(sessionId, state);
      // Buffer holds the contiguous seq range [latestSeq - size + 1, latestSeq].
      const retained = state.buffer.toArray();
      const latestSeq = state.seq;
      const oldestSeq =
        retained.length > 0 ? latestSeq - retained.length + 1 : 0;
      // Gap: the event right after the cursor was already overwritten (ring
      // wrapped), or the cursor claims a seq we never issued this epoch.
      const gap =
        afterSeq > latestSeq ||
        (retained.length > 0 ? afterSeq + 1 < oldestSeq : afterSeq < latestSeq);
      const missedCount = Math.min(
        retained.length,
        Math.max(0, latestSeq - afterSeq),
      );
      return {
        events:
          missedCount > 0 ? retained.slice(retained.length - missedCount) : [],
        gap,
        epoch: state.epoch,
        oldestSeq,
        latestSeq,
      };
    },

    pin(sessionId: string): SessionPin {
      const state = touchSession(sessionId);
      state.pinCount += 1;
      let released = false;
      return {
        epoch: state.epoch,
        release(): void {
          if (released) return;
          released = true;
          state.pinCount -= 1;
          // Restart the idle clock so an unpinned session isn't swept instantly.
          state.lastTouchedMs = Date.now();
        },
      };
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
