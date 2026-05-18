/**
 * API Trace routes — read-only endpoints for debug trace inspection.
 */

import { Hono } from "hono";
import type { DataStore, TraceEventRecord } from "@covel/store";
import type { PluginRegistry } from "@covel/plugin-loader";
import { buildSessionDiscoverySnapshot } from "./discovery.js";

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

  // Group events by turnId
  const turnMap = new Map<string, TraceEventRecord[]>();
  for (const evt of events) {
    const turnId = evt.turnId || "__unknown__";
    const arr = turnMap.get(turnId);
    if (arr) {
      arr.push(evt);
    } else {
      turnMap.set(turnId, [evt]);
    }
  }

  // Build turn summaries sorted by first event timestamp
  const turns = Array.from(turnMap.entries())
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

  return c.json({
    sessionId,
    turnCount: turns.length,
    discovery,
    turns,
  });
});

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
