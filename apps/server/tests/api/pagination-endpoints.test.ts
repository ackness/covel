/**
 * Keyset-cursor pagination endpoints:
 *   GET /api/sessions/:id/messages/page
 *   GET /api/traces/:sessionId/turns/page
 *
 * Both page an append-only, time-ordered log oldest-first with a
 * `(before_created_at, before_id)` cursor. Exercised with small `?limit` so the
 * windowing/cursor logic is verified without seeding a full default window.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { messageRoutes } from "../../src/routes/api/messages.js";
import { traceRoutes } from "../../src/routes/api/traces.js";

type Env = { Variables: { store: DataStore } };

function buildApp(store: DataStore): Hono {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("store", store);
    await next();
  });
  app.route("/api/sessions", messageRoutes);
  app.route("/api/traces", traceRoutes);
  return app;
}

const sessionId = "sess-page";

async function seedSession(store: DataStore): Promise<void> {
  await store.createSession({
    id: sessionId,
    worldId: "cloudmere",
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    locale: "zh-CN",
    activePlugins: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

describe("GET /api/sessions/:id/messages/page", () => {
  let store: DataStore;
  let app: Hono;

  beforeEach(async () => {
    store = createMemoryStore();
    app = buildApp(store);
    await seedSession(store);
    for (let i = 1; i <= 4; i++) {
      await store.addMessage({
        id: `m${i}`,
        sessionId,
        role: "user",
        content: `msg ${i}`,
        metadata: { turnId: `t${i}` },
        createdAt: ts(i * 10),
      });
    }
  });

  it("returns the newest window oldest-first with a nextCursor", async () => {
    const res = await app.request(
      `/api/sessions/${sessionId}/messages/page?limit=2`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; turnId?: string }>;
      nextCursor: { createdAt: string; id: string } | null;
    };
    expect(body.items.map((m) => m.id)).toEqual(["m3", "m4"]);
    // Metadata is flattened to top-level.
    expect(body.items[0].turnId).toBe("t3");
    expect(body.nextCursor).toEqual({ createdAt: ts(30), id: "m3" });
  });

  it("pages older when given the cursor, and ends with a null cursor", async () => {
    const res = await app.request(
      `/api/sessions/${sessionId}/messages/page?limit=2&before_created_at=${encodeURIComponent(
        ts(30),
      )}&before_id=m3`,
    );
    const body = (await res.json()) as {
      items: Array<{ id: string }>;
      nextCursor: unknown;
    };
    expect(body.items.map((m) => m.id)).toEqual(["m1", "m2"]);
    // Exactly `limit` returned → there *might* be more; cursor points older.
    expect(body.nextCursor).toEqual({ createdAt: ts(10), id: "m1" });

    const end = await app.request(
      `/api/sessions/${sessionId}/messages/page?limit=2&before_created_at=${encodeURIComponent(
        ts(10),
      )}&before_id=m1`,
    );
    const endBody = (await end.json()) as {
      items: unknown[];
      nextCursor: unknown;
    };
    expect(endBody.items).toEqual([]);
    expect(endBody.nextCursor).toBeNull();
  });

  it("404s for an unknown session", async () => {
    const res = await app.request(`/api/sessions/nope/messages/page`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/traces/:sessionId/turns/page", () => {
  let store: DataStore;
  let app: Hono;

  beforeEach(async () => {
    store = createMemoryStore();
    app = buildApp(store);
    // Trace routes now require the session to exist (owner guard).
    await seedSession(store);
    // Two turns, two events each, inserted out of order.
    const events = [
      { id: "e1", turnId: "t1", at: ts(10) },
      { id: "e2", turnId: "t1", at: ts(20) },
      { id: "e3", turnId: "t2", at: ts(30) },
      { id: "e4", turnId: "t2", at: ts(40) },
    ];
    for (const e of [events[2], events[0], events[3], events[1]]) {
      await store.addTraceEvent({
        id: e.id,
        sessionId,
        type: "llm_call",
        traceId: "trace-1",
        turnId: e.turnId,
        payload: {},
        createdAt: e.at,
      });
    }
  });

  it("groups the newest event window into turns with an event cursor", async () => {
    const res = await app.request(
      `/api/traces/${sessionId}/turns/page?limit=2`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      turns: Array<{ turnId: string; eventCount: number }>;
      nextCursor: { createdAt: string; id: string } | null;
    };
    // Newest 2 events belong to t2.
    expect(body.turns.map((t) => t.turnId)).toEqual(["t2"]);
    expect(body.turns[0].eventCount).toBe(2);
    // Cursor is the oldest event of the window (an event, not a turn).
    expect(body.nextCursor).toEqual({ createdAt: ts(30), id: "e3" });
  });

  it("pages older turns via the event cursor", async () => {
    const res = await app.request(
      `/api/traces/${sessionId}/turns/page?limit=2&before_created_at=${encodeURIComponent(
        ts(30),
      )}&before_id=e3`,
    );
    const body = (await res.json()) as {
      turns: Array<{ turnId: string }>;
      nextCursor: unknown;
    };
    expect(body.turns.map((t) => t.turnId)).toEqual(["t1"]);
    expect(body.nextCursor).toEqual({ createdAt: ts(10), id: "e1" });
  });
});
