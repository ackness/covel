/**
 * API Subscription routes — unified SSE stream with topic filtering and replay.
 *
 * GET /stream?sessionId=xxx&topics=runtime,state&lastEventId=xxx
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "@covel/events";
import type { DataStore } from "@covel/store";
import type { SubscriptionEvent, SubscriptionTopic } from "@covel/shared";
import {
  SUBSCRIPTION_TOPICS,
  parseSubscriptionEventId,
  readRuntimeEnv,
} from "@covel/shared";
import { errorBody } from "../../api-error.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import { checkSessionOwner } from "./session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
    eventBus: EventBus;
  };
};

export const subscribeRoutes = new Hono<Env>();

/**
 * Concurrent-connection cap per session. Multiple browser tabs on one session
 * are legitimate, so the cap is generous; it exists only to bound a runaway
 * reconnect loop or a single abusive client from holding unbounded streams.
 */
const MAX_CONNECTIONS_PER_SESSION = 8;
const MAX_TOTAL_CONNECTIONS = 512;
const SSE_WRITE_QUEUE_MAX = 256;

export interface ConnectionBudgetOptions {
  readonly maxTotal: number;
  readonly maxPerSession: number;
}

type ConnectionLease =
  | { readonly ok: true; release(): void }
  | { readonly ok: false; readonly reason: "session" | "global" };

/** Small synchronous budget used to bound both SSE streams and EventBus pins. */
export function createConnectionBudget(options: ConnectionBudgetOptions): {
  reserve(sessionId: string): ConnectionLease;
  active(): number;
} {
  const perSession = new Map<string, number>();
  let total = 0;
  return {
    reserve(sessionId: string): ConnectionLease {
      const current = perSession.get(sessionId) ?? 0;
      if (current >= options.maxPerSession) {
        return { ok: false, reason: "session" };
      }
      if (total >= options.maxTotal) {
        return { ok: false, reason: "global" };
      }
      perSession.set(sessionId, current + 1);
      total += 1;
      let released = false;
      return {
        ok: true,
        release(): void {
          if (released) return;
          released = true;
          total -= 1;
          const remaining = (perSession.get(sessionId) ?? 1) - 1;
          if (remaining === 0) perSession.delete(sessionId);
          else perSession.set(sessionId, remaining);
        },
      };
    },
    active(): number {
      return total;
    },
  };
}

export interface BoundedSerialQueueOptions {
  readonly capacity: number;
  readonly onOverflow: () => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Serializes asynchronous writes and caps accepted running/queued work.
 * Overflow closes the queue; work that has not started is discarded.
 */
export function createBoundedSerialQueue(options: BoundedSerialQueueOptions): {
  enqueue(task: () => Promise<void>): boolean;
  close(): void;
  drain(): Promise<void>;
  pending(): number;
} {
  let tail = Promise.resolve();
  let pending = 0;
  let closed = false;
  let overflowed = false;
  return {
    enqueue(task: () => Promise<void>): boolean {
      if (closed) return false;
      if (pending >= options.capacity) {
        closed = true;
        if (!overflowed) {
          overflowed = true;
          options.onOverflow();
        }
        return false;
      }
      pending += 1;
      const run = tail
        .then(async () => {
          if (!closed) await task();
        })
        .catch((error: unknown) => {
          closed = true;
          options.onError?.(error);
        })
        .finally(() => {
          pending -= 1;
        });
      tail = run;
      return true;
    },
    close(): void {
      closed = true;
    },
    drain(): Promise<void> {
      return tail;
    },
    pending(): number {
      return pending;
    },
  };
}

const connectionBudget = createConnectionBudget({
  maxTotal: MAX_TOTAL_CONNECTIONS,
  maxPerSession: MAX_CONNECTIONS_PER_SESSION,
});

/**
 * Derive the SSE event field name from a SubscriptionEvent.
 *
 * EventBus normalises `payload._subType` onto `event.type` before handlers
 * run (see packages/events/src/event-bus.ts), so `event.type` already holds
 * the full semantic type (`plugin-data.changed`, `world.dimensions.changed`,
 * `runtime.started`, …). Emit it verbatim — any rewriting here silently
 * drops subType segments and breaks the frontend switch matchers that route
 * plugin panels and world updates.
 *
 * Exported for regression tests (tests/api/subscribe-event-name.test.ts).
 */
export function deriveSseEventName(event: {
  topic: string;
  type: string;
  payload?: Record<string, unknown>;
}): string {
  return event.type;
}

// GET /events/stream?sessionId=xxx&topics=runtime,state&lastEventId=xxx
// Rate-limited per IP (RATE_LIMIT_RPM, default 60) plus a per-session
// concurrent-connection cap below — SSE reconnects otherwise have no ceiling.
subscribeRoutes.get(
  "/stream",
  rateLimiter({ max: readRuntimeEnv().rateLimitRpm }),
  async (c) => {
    const store = c.get("store");
    const eventBus = c.get("eventBus");

    const sessionId = c.req.query("sessionId");
    if (!sessionId) return c.json(errorBody("sessionId required"), 400);

    const session = await store.getSession(sessionId);
    if (!session) return c.json(errorBody("Session not found"), 404);

    // Owner guard (hosted tiers, S-02). EventSource cannot set headers, so
    // clients pass `?session_token=` — see extractSessionOwnerToken.
    const denied = checkSessionOwner(c, session);
    if (denied) return denied;

    const topicsParam = c.req.query("topics");
    // M2: Validate topics parameter against known SubscriptionTopic values.
    // Derived from the shared `SUBSCRIPTION_TOPICS` source of truth so the guard
    // can never drift from the `SubscriptionTopic` union (which now includes the
    // runtime-internal `trace` / `hooks` topics emitted by TurnEmitter and the
    // hook pipeline).
    const VALID_TOPICS = new Set<string>(SUBSCRIPTION_TOPICS);
    if (topicsParam) {
      const parsed = topicsParam.split(",").map((t) => t.trim());
      const invalid = parsed.filter((t) => !VALID_TOPICS.has(t));
      if (invalid.length > 0) {
        return c.json(errorBody(`Invalid topics: ${invalid.join(", ")}`), 400);
      }
    }
    const topics = topicsParam
      ? new Set(
          topicsParam.split(",").map((t) => t.trim()) as SubscriptionTopic[],
        )
      : null; // null = all topics

    const lastEventId = c.req.query("lastEventId");

    // Per-session concurrent-connection cap. Checked (and reserved) before the
    // stream starts so we can still return a 429 JSON body; released in the
    // stream's `finally` below.
    const connectionLease = connectionBudget.reserve(sessionId);
    if (!connectionLease.ok) {
      return c.json(
        errorBody(
          connectionLease.reason === "session"
            ? "Too many concurrent connections for session"
            : "Too many concurrent event-stream connections",
          {
            code:
              connectionLease.reason === "session"
                ? "connection_limit_exceeded"
                : "global_connection_limit_exceeded",
          },
        ),
        429,
      );
    }

    try {
      return streamSSE(c, async (stream) => {
        // R-01 Bug A (event-loss race): register the live listener BEFORE
        // computing/sending the replay batch. Events emitted during replay are
        // buffered here and flushed afterwards, deduped by id against what
        // replay already sent — so nothing is lost and nothing double-sends.
        //
        // H-08: everything acquired here (listener, reset listener, session
        // pin, heartbeat, queue, connection slot) is released in one finally.
        const sentIds = new Set<string>();
        const liveBuffer: SubscriptionEvent[] = [];
        let replaying = true;
        let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
        let resolveDone = (): void => {};
        let closing = false;
        let resetScheduled = false;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });

        const closeStream = (): void => {
          if (closing) return;
          closing = true;
          stream.abort();
          resolveDone();
        };

        const writes = createBoundedSerialQueue({
          capacity: SSE_WRITE_QUEUE_MAX,
          onOverflow: closeStream,
          onError: closeStream,
        });

        const writeEvent = (event: SubscriptionEvent): Promise<void> => {
          sentIds.add(event.id);
          return stream.writeSSE({
            id: event.id,
            event: deriveSseEventName(event),
            data: JSON.stringify(event),
          });
        };

        const resetPayload = (reason: string): string => {
          const replay = eventBus.getEventsAfter(sessionId, 0);
          return JSON.stringify({
            sessionId,
            reason,
            epoch: replay.epoch,
            oldestSeq: replay.oldestSeq,
            latestSeq: replay.latestSeq,
            timestamp: new Date().toISOString(),
          });
        };

        let unsubscribe = (): void => {};
        let unsubscribeReset: (() => void) | undefined;
        let pinned: ReturnType<EventBus["pin"]> | undefined;
        try {
          unsubscribe = eventBus.onEmit((event) => {
            if (event.sessionId !== sessionId) return;
            if (topics && !topics.has(event.topic)) return;
            if (replaying) {
              if (liveBuffer.length >= SSE_WRITE_QUEUE_MAX) {
                closeStream();
                return;
              }
              liveBuffer.push(event);
              return;
            }
            // H-06(3): no sentIds bookkeeping on the live path — dedupe only
            // covers the replay→live cutover window; live ids are epoch-unique.
            writes.enqueue(() =>
              stream.writeSSE({
                id: event.id,
                event: deriveSseEventName(event),
                data: JSON.stringify(event),
              }),
            );
          });
          unsubscribeReset = eventBus.onReset?.((reset) => {
            if (reset.sessionId !== sessionId || resetScheduled) return;
            resetScheduled = true;
            if (replaying) {
              // The replay epoch has changed under this request. Disconnecting
              // makes the reconnect run the ordinary epoch-reset handshake.
              closeStream();
              return;
            }
            writes.enqueue(async () => {
              await stream.writeSSE({
                event: "system.reset",
                data: resetPayload(reset.reason),
              });
              closeStream();
            });
          });
          // H-06(1): pin the session's replay state for the lifetime of this
          // stream so LRU/TTL eviction can't reset its seq/epoch underneath an
          // active subscriber. Transport gaps explicitly invalidate pinned
          // state and are surfaced through onReset above.
          pinned = eventBus.pin(sessionId);
          stream.onAbort(() => {
            closing = true;
            resolveDone();
          });

          // R-01 Bug B (cursor reset): the connected frame carries NO id, so the
          // frontend never clobbers its lastEventId back to "0" on reconnect
          // (mirrors the id-less heartbeat frame below).
          await stream.writeSSE({
            event: "system.connected",
            data: JSON.stringify({
              sessionId,
              topics: topics ? [...topics] : "all",
              timestamp: new Date().toISOString(),
            }),
          });
          if (closing) return;

          // Replay missed events if lastEventId provided. Ids are epoch-scoped
          // (`${epoch}:${seq}`): when the cursor's epoch no longer matches, or
          // the ring buffer can't bridge the seq (H-05 gap), emit an id-less
          // `system.reset` control frame instead of a partial replay.
          if (lastEventId) {
            const cursor = parseSubscriptionEventId(lastEventId);
            const replay = eventBus.getEventsAfter(sessionId, cursor?.seq ?? 0);
            const epoch = replay.epoch ?? pinned.epoch;
            const epochChanged = !cursor || cursor.epoch !== epoch;
            if (epochChanged || replay.gap) {
              await stream.writeSSE({
                event: "system.reset",
                data: JSON.stringify({
                  sessionId,
                  reason: epochChanged ? "epoch-change" : "gap",
                  epoch,
                  oldestSeq: replay.oldestSeq,
                  latestSeq: replay.latestSeq,
                  timestamp: new Date().toISOString(),
                }),
              });
            } else {
              for (const event of replay.events) {
                if (!topics || topics.has(event.topic)) {
                  await writeEvent(event);
                  if (closing) return;
                }
              }
            }
          }

          // Flush events buffered during replay, deduped by id. New events keep
          // buffering until the buffer drains; the final drain-check and flag
          // flip run synchronously, so no event can slip past both paths.
          while (liveBuffer.length > 0) {
            const batch = liveBuffer.splice(0);
            for (const event of batch) {
              if (sentIds.has(event.id)) continue;
              await writeEvent(event);
              if (closing) return;
            }
          }
          replaying = false;
          sentIds.clear();

          // Heartbeats share the same serial queue as live events, preventing
          // concurrent writes when a client is applying backpressure.
          heartbeatInterval = setInterval(() => {
            writes.enqueue(() =>
              stream.writeSSE({
                event: "system.heartbeat",
                data: JSON.stringify({ timestamp: new Date().toISOString() }),
              }),
            );
          }, 30000);

          await done;
        } catch (err) {
          console.error(
            `[subscribe] SSE stream error (session ${sessionId}):`,
            err,
          );
        } finally {
          writes.close();
          unsubscribe();
          unsubscribeReset?.();
          pinned?.release();
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          connectionLease.release();
        }
      });
    } catch (err) {
      connectionLease.release();
      throw err;
    }
  },
);
