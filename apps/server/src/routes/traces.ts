import { Hono } from "hono";
import type { MemoryStore } from "../store/memory-store.js";

/**
 * GET /api/traces/:sessionId — Return all trace events for a session.
 * GET /api/traces/:sessionId/turns — Return trace events grouped by turnId.
 */
export function createTracesRoute(store: MemoryStore) {
  const route = new Hono();

  // All events for a session (flat list, chronological)
  route.get("/:sessionId", (c) => {
    const { sessionId } = c.req.param();
    const events = store.listTraceEvents(sessionId);
    return c.json({ sessionId, count: events.length, events });
  });

  // Events grouped by turnId
  route.get("/:sessionId/turns", (c) => {
    const { sessionId } = c.req.param();
    const events = store.listTraceEvents(sessionId);

    const turnMap = new Map<string, typeof events>();
    for (const evt of events) {
      const key = evt.turnId || "__no_turn__";
      const list = turnMap.get(key) ?? [];
      list.push(evt);
      turnMap.set(key, list);
    }

    const turns = Array.from(turnMap.entries()).map(([turnId, turnEvents]) => ({
      turnId,
      flowId: turnEvents[0]?.flowId ?? "",
      traceId: turnEvents[0]?.traceId ?? "",
      startedAt: turnEvents[0]?.timestamp ?? "",
      completedAt: turnEvents[turnEvents.length - 1]?.timestamp ?? "",
      eventCount: turnEvents.length,
      events: turnEvents,
    }));

    return c.json({ sessionId, turnCount: turns.length, turns });
  });

  return route;
}
