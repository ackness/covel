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
import { SUBSCRIPTION_TOPICS, readRuntimeEnv } from "@covel/shared";
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
const sessionConnections = new Map<string, number>();

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
    const activeConnections = sessionConnections.get(sessionId) ?? 0;
    if (activeConnections >= MAX_CONNECTIONS_PER_SESSION) {
      return c.json(
        errorBody("Too many concurrent connections for session", {
          code: "connection_limit_exceeded",
        }),
        429,
      );
    }
    sessionConnections.set(sessionId, activeConnections + 1);

    return streamSSE(c, async (stream) => {
      try {
        // R-01 Bug A (event-loss race): register the live listener BEFORE
        // computing/sending the replay batch. Events emitted during replay are
        // buffered here and flushed afterwards, deduped by id against what
        // replay already sent — so nothing is lost and nothing double-sends.
        const sentIds = new Set<string>();
        const liveBuffer: SubscriptionEvent[] = [];
        let replaying = true;

        const writeEvent = (event: SubscriptionEvent): Promise<void> => {
          sentIds.add(event.id);
          return stream.writeSSE({
            id: event.id,
            event: deriveSseEventName(event),
            data: JSON.stringify(event),
          });
        };

        const unsubscribe = eventBus.onEmit((event) => {
          if (event.sessionId !== sessionId) return;
          if (topics && !topics.has(event.topic)) return;
          if (replaying) {
            liveBuffer.push(event);
            return;
          }
          if (sentIds.has(event.id)) return;
          writeEvent(event).catch(() => {
            // Connection closed — cleanup will happen via abort
          });
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

        // Replay missed events if lastEventId provided.
        if (lastEventId) {
          const afterSeq = parseInt(lastEventId, 10);
          if (!isNaN(afterSeq)) {
            const missed = eventBus.getEventsAfter(sessionId, afterSeq);
            for (const event of missed) {
              if (!topics || topics.has(event.topic)) {
                await writeEvent(event);
              }
            }
          }
        }

        // Flush events buffered during replay, deduped by id. New events keep
        // buffering until the buffer drains; the final drain-check and the flag
        // flip run synchronously (no await between), so no event can slip past
        // both the buffer and the live path.
        while (liveBuffer.length > 0) {
          const batch = liveBuffer.splice(0);
          for (const event of batch) {
            if (sentIds.has(event.id)) continue;
            await writeEvent(event);
          }
        }
        replaying = false;

        // Heartbeat every 30 seconds
        const heartbeatInterval = setInterval(async () => {
          try {
            await stream.writeSSE({
              event: "system.heartbeat",
              data: JSON.stringify({ timestamp: new Date().toISOString() }),
            });
          } catch {
            clearInterval(heartbeatInterval);
          }
        }, 30000);

        // Keep the stream open until the client disconnects.
        // Without this, the async callback returns immediately and Hono closes the stream.
        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            unsubscribe();
            clearInterval(heartbeatInterval);
            resolve();
          });
        });
      } finally {
        const remaining = (sessionConnections.get(sessionId) ?? 1) - 1;
        if (remaining <= 0) sessionConnections.delete(sessionId);
        else sessionConnections.set(sessionId, remaining);
      }
    });
  },
);
