/**
 * Runtime-outputs API integration tests.
 *
 * Covers the new translation-layer endpoints:
 *   GET /api/sessions/:id/runtime-outputs
 *   GET /api/sessions/:id/runtime-outputs/:outputId
 *   GET /api/sessions/:id/runtime-outputs/:outputId/full-prompt
 *   GET /api/sessions/:id/interaction-records
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createMemoryStore,
  type DataStore,
  type RuntimeOutputRecord,
  type InteractionRecordRow,
} from "@covel/store";
import { runtimeOutputRoutes } from "../../src/routes/api/runtime-outputs.js";

type Env = { Variables: { store: DataStore } };

function setupApp(store: DataStore): Hono {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("store", store);
    await next();
  });
  app.route("/api/sessions", runtimeOutputRoutes);
  return app;
}

function makeRuntimeOutput(
  overrides: Partial<RuntimeOutputRecord> = {},
): RuntimeOutputRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    sessionId: "sess-1",
    turnId: "turn-1",
    runtimeResultId: crypto.randomUUID(),
    pluginId: "narrator",
    runtimeId: "narrator",
    timestamp: now,
    results: [{ text: "hello", structured: { narrative: "hello" } }],
    metaData: {
      turn: 0,
      toolCallList: [],
    },
    createdAt: now,
    ...overrides,
  };
}

function makeInteractionRecord(
  overrides: Partial<InteractionRecordRow> = {},
): InteractionRecordRow {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    sessionId: "sess-1",
    turnId: "turn-1",
    timestamp: now,
    source: "player",
    channel: "web",
    type: "message",
    payload: { content: "hi" },
    createdAt: now,
    ...overrides,
  };
}

describe("runtime-outputs API", () => {
  let store: DataStore;
  let app: Hono;

  beforeEach(async () => {
    store = createMemoryStore();
    app = setupApp(store);
    await store.createSession({
      id: "sess-1",
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  describe("GET /sessions/:id/runtime-outputs", () => {
    it("returns an empty list for a new session", async () => {
      const res = await app.request("/api/sessions/sess-1/runtime-outputs");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toEqual([]);
    });

    it("returns 404 for unknown sessions", async () => {
      const res = await app.request(
        "/api/sessions/nonexistent/runtime-outputs",
      );
      expect(res.status).toBe(404);
    });

    it("returns saved runtime outputs", async () => {
      const ro = makeRuntimeOutput();
      await store.saveRuntimeOutput(ro);

      const res = await app.request("/api/sessions/sess-1/runtime-outputs");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: RuntimeOutputRecord[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.id).toBe(ro.id);
      expect(body.items[0]!.results).toEqual([
        { text: "hello", structured: { narrative: "hello" } },
      ]);
    });

    it("filters by runtimeId", async () => {
      await store.saveRuntimeOutput(
        makeRuntimeOutput({ runtimeId: "narrator" }),
      );
      await store.saveRuntimeOutput(makeRuntimeOutput({ runtimeId: "guide" }));

      const res = await app.request(
        "/api/sessions/sess-1/runtime-outputs?runtimeId=guide",
      );
      const body = (await res.json()) as { items: RuntimeOutputRecord[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.runtimeId).toBe("guide");
    });

    it("respects limit", async () => {
      for (let i = 0; i < 5; i++) {
        await store.saveRuntimeOutput(makeRuntimeOutput({ id: `ro-${i}` }));
      }
      const res = await app.request(
        "/api/sessions/sess-1/runtime-outputs?limit=2",
      );
      const body = (await res.json()) as { items: RuntimeOutputRecord[] };
      expect(body.items).toHaveLength(2);
    });
  });

  describe("GET /sessions/:id/runtime-outputs/:outputId", () => {
    it("returns a single record by id", async () => {
      const ro = makeRuntimeOutput();
      await store.saveRuntimeOutput(ro);

      const res = await app.request(
        `/api/sessions/sess-1/runtime-outputs/${ro.id}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as RuntimeOutputRecord;
      expect(body.id).toBe(ro.id);
    });

    it("returns 404 for missing records", async () => {
      const res = await app.request(
        "/api/sessions/sess-1/runtime-outputs/missing",
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /sessions/:id/runtime-outputs/:outputId/full-prompt", () => {
    it("rebuilds the message history from turn_messages", async () => {
      const ro = makeRuntimeOutput({
        metaData: { turn: 0 },
      });
      await store.saveRuntimeOutput(ro);
      await store.appendTurnMessage({
        id: "m1",
        sessionId: "sess-1",
        turnId: "turn-1",
        sourceType: "player",
        role: "system",
        content: "you are a narrator",
        order: 100,
        createdAt: new Date().toISOString(),
      });

      const res = await app.request(
        `/api/sessions/sess-1/runtime-outputs/${ro.id}/full-prompt`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: Array<{ role: string; content: string }>;
      };
      // History only. The endpoint never had a second source: the delta it
      // used to concatenate was read from a metaData field no producer wrote.
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]!.role).toBe("system");
      expect(body.messages[0]!.content).toBe("you are a narrator");
    });
  });

  describe("GET /sessions/:id/interaction-records", () => {
    it("returns saved interaction records", async () => {
      await store.saveInteractionRecord(makeInteractionRecord());
      const res = await app.request("/api/sessions/sess-1/interaction-records");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: InteractionRecordRow[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.type).toBe("message");
    });

    it("filters by type", async () => {
      await store.saveInteractionRecord(
        makeInteractionRecord({ type: "message" }),
      );
      await store.saveInteractionRecord(
        makeInteractionRecord({ type: "form-submit" }),
      );

      const res = await app.request(
        "/api/sessions/sess-1/interaction-records?type=form-submit",
      );
      const body = (await res.json()) as { items: InteractionRecordRow[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.type).toBe("form-submit");
    });
  });
});
