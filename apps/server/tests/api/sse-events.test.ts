/**
 * V2 SSE Events — tests for EventBus-wired SSE subscribe and emit endpoints.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createEventBus, type EventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";
import { eventRoutes } from "../../src/routes/api/events.js";
import type { CovelMessage } from "@covel/shared";

function createTestApp(eventBus: EventBus): Hono {
  const store = createMemoryStore();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus", eventBus);
    c.set("store", store);
    await next();
  });
  app.route("/api/events", eventRoutes);
  return app;
}

describe("V2 SSE Events", () => {
  let app: Hono;
  let eventBus: EventBus;

  beforeEach(() => {
    const store = createMemoryStore();
    eventBus = createEventBus(store);
    app = createTestApp(eventBus);
  });

  describe("POST /api/events/emit", () => {
    it("should emit an event and return id", async () => {
      const res = await app.request("/api/events/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: "quest.completed",
          payload: { questId: "q-1", reward: 100 },
          sessionId: "sess-1",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.emitted).toBe(true);
    });

    it("should trigger EventBus handlers", async () => {
      const received: CovelMessage[] = [];
      eventBus.on("test.event", (msg) => {
        received.push(msg);
      });

      await app.request("/api/events/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: "test.event",
          payload: { data: "hello" },
          sessionId: "sess-1",
        }),
      });

      expect(received).toHaveLength(1);
      expect(received[0].payload).toEqual({ data: "hello" });
    });

    it("should require topic and sessionId", async () => {
      const res = await app.request("/api/events/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: {} }),
      });
      expect(res.status).toBe(400);
    });

    it("should pass targetRuntime if provided", async () => {
      const received: CovelMessage[] = [];
      eventBus.on("routed.event", (msg) => {
        received.push(msg);
      });

      await app.request("/api/events/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: "routed.event",
          payload: { x: 1 },
          sessionId: "sess-1",
          targetRuntime: "narrator/narrator",
        }),
      });

      expect(received).toHaveLength(1);
      expect(received[0].targetRuntime).toBe("narrator/narrator");
    });
  });

  describe("GET /api/events/stream (subscribe route)", () => {
    it("M2: should return 400 for invalid topics parameter", async () => {
      // We need a session for this — create a test app with subscribe routes
      const { subscribeRoutes } =
        await import("../../src/routes/api/subscribe.js");
      const subApp = new Hono();
      const store = createMemoryStore();
      // Create a session so the route can find it
      await store.createSession({
        id: "sess-topic",
        worldId: null,
        status: "active",
        turnCount: 1,
        preGameCompleted: [],
        presetId: null,
        activePlugins: [],
        createdAt: new Date().toISOString(),
      });
      subApp.use("*", async (c, next) => {
        c.set("eventBus", eventBus);
        c.set("store", store);
        await next();
      });
      subApp.route("/api/events", subscribeRoutes);

      const res = await subApp.request(
        "/api/events/stream?sessionId=sess-topic&topics=runtime,bogus_topic",
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain("bogus_topic");
    });
  });
});
