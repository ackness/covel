import { Hono } from "hono";
import type { StoreService } from "../store-service.js";
import type { TraceEventRecord } from "@covel/store";

function toApiTraceEvent(event: TraceEventRecord) {
  return {
    ...event,
    timestamp: event.createdAt,
  };
}

function pickCanonicalId(ids: string[], finalPrefix: string): string {
  return ids.find((id) => id.startsWith(finalPrefix)) ?? ids[0] ?? "";
}

/**
 * GET /api/traces/:sessionId — Return all trace events for a session.
 * GET /api/traces/:sessionId/turns — Return trace events grouped by turnId.
 */
export function createTracesRoute(store: StoreService) {
  const route = new Hono();

  // All events for a session (flat list, chronological)
  route.get("/:sessionId", async (c) => {
    const { sessionId } = c.req.param();
    const events = await store.listTraceEvents(sessionId);
    return c.json({
      sessionId,
      count: events.length,
      events: events.map(toApiTraceEvent),
    });
  });

  // Events grouped by turnId
  route.get("/:sessionId/turns", async (c) => {
    const { sessionId } = c.req.param();
    const events = await store.listTraceEvents(sessionId);

    const turnMap = new Map<string, typeof events>();
    for (const evt of events) {
      const key = evt.flowId || evt.turnId || "__no_turn__";
      const list = turnMap.get(key) ?? [];
      list.push(evt);
      turnMap.set(key, list);
    }

    const turns = Array.from(turnMap.entries()).map(([, turnEvents]) => {
      const turnIds = Array.from(new Set(turnEvents.map((evt) => evt.turnId).filter(Boolean)));
      const traceIds = Array.from(new Set(turnEvents.map((evt) => evt.traceId).filter(Boolean)));

      return {
        turnId: pickCanonicalId(turnIds, "turn-"),
        flowId: turnEvents[0]?.flowId ?? "",
        traceId: pickCanonicalId(traceIds, "trace-"),
        startedAt: turnEvents[0]?.createdAt ?? "",
        completedAt: turnEvents[turnEvents.length - 1]?.createdAt ?? "",
        eventCount: turnEvents.length,
        events: turnEvents.map(toApiTraceEvent),
      };
    });

    return c.json({ sessionId, turnCount: turns.length, turns });
  });

  return route;
}
