/**
 * API Trace routes — read-only endpoints for debug trace inspection.
 */

import { Hono } from "hono";
import type { DataStore, TraceEventRecord } from "@covel/store";
import type { PluginRegistry } from "@covel/plugin-loader";
import { buildSessionDiscoverySnapshot } from "./discovery.js";
import { nextCursorFrom, parseCursorQuery } from "./cursor-params.js";
import { rateLimiter } from "../../middleware/rate-limit.js";

/** Default per-page event window for the paged turns endpoint. */
const TRACE_PAGE_EVENT_LIMIT = 400;

/**
 * Group a flat, chronologically-ordered event list into per-turn summaries,
 * sorted by first-event time. Turn is the natural page unit — an event-level
 * window can split a turn, so callers page the *events* and let the frontend
 * merge a boundary turn across pages by turnId.
 */
function buildTurnSummaries(events: readonly TraceEventRecord[]) {
  const turnMap = new Map<string, TraceEventRecord[]>();
  for (const evt of events) {
    const turnId = evt.turnId || "__unknown__";
    const arr = turnMap.get(turnId);
    if (arr) arr.push(evt);
    else turnMap.set(turnId, [evt]);
  }

  return Array.from(turnMap.entries())
    .map(([turnId, turnEvents]) => {
      const sorted = turnEvents.sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      const firstEvt = sorted[0];
      const lastEvt = sorted[sorted.length - 1];
      const payload = firstEvt.payload as Record<string, unknown> | null;
      const flowId = (payload?.flowId as string) ?? "";
      const traceId = firstEvt.traceId ?? "";

      return {
        turnId,
        flowId,
        traceId,
        startedAt: firstEvt.createdAt,
        completedAt: lastEvt.createdAt,
        eventCount: sorted.length,
        events: sorted.map(toApiTraceEvent),
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry?: PluginRegistry;
    builtinToolNames?: readonly string[];
  };
};

export const traceRoutes = new Hono<Env>();

// GET /:sessionId — list all trace events for a session
traceRoutes.get("/:sessionId", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("sessionId");

  const events = await store.listTraceEvents(sessionId);
  const discovery = await buildSessionDiscoverySnapshot({
    store,
    registry: c.get("pluginRegistry"),
    sessionId,
    builtinToolNames: c.get("builtinToolNames"),
  });

  return c.json({
    sessionId,
    count: events.length,
    discovery,
    events: events.map(toApiTraceEvent),
  });
});

// GET /:sessionId/turns — trace events grouped by turn
traceRoutes.get("/:sessionId/turns", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("sessionId");

  const events = await store.listTraceEvents(sessionId);
  const discovery = await buildSessionDiscoverySnapshot({
    store,
    registry: c.get("pluginRegistry"),
    sessionId,
    builtinToolNames: c.get("builtinToolNames"),
  });

  const turns = buildTurnSummaries(events);

  return c.json({
    sessionId,
    turnCount: turns.length,
    discovery,
    turns,
  });
});

// GET /:sessionId/turns/page — turns from the most-recent event window. `?limit`
// (events, not turns), `?before_created_at`, `?before_id` (see cursor-params).
// nextCursor is the oldest event's position; the frontend merges a turn split
// across the window boundary by turnId when it loads the next (older) page.
traceRoutes.get(
  "/:sessionId/turns/page",
  rateLimiter({ max: 120 }),
  async (c) => {
    const store = c.get("store");
    const sessionId = c.req.param("sessionId");
    const { limit, before } = parseCursorQuery(c, TRACE_PAGE_EVENT_LIMIT);

    const events = await store.listTraceEventsPage(sessionId, {
      limit,
      before,
    });
    // Discovery is a session-level snapshot (getSession + N× listPluginData), not
    // per-page — only rebuild it for the first page (no cursor). "Load older"
    // pages reuse the discovery the client already has, avoiding N DB reads per
    // scroll step.
    const discovery = before
      ? undefined
      : await buildSessionDiscoverySnapshot({
          store,
          registry: c.get("pluginRegistry"),
          sessionId,
          builtinToolNames: c.get("builtinToolNames"),
        });

    return c.json({
      sessionId,
      turns: buildTurnSummaries(events),
      nextCursor: nextCursorFrom(events, limit),
      ...(discovery ? { discovery } : {}),
    });
  },
);

/**
 * Map a store TraceEventRecord to the shape expected by the frontend API client.
 */
function toApiTraceEvent(record: TraceEventRecord) {
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  return {
    type: record.type,
    requestId: (payload.requestId as string) ?? "",
    traceId: record.traceId ?? "",
    sessionId: record.sessionId,
    turnId: record.turnId ?? "",
    flowId: (payload.flowId as string) ?? "",
    seq: (payload.seq as number) ?? 0,
    timestamp: record.createdAt,
    payload,
  };
}
