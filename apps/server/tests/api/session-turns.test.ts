/**
 * GET /api/sessions/:id/turns — persisted turn artifact listing.
 *
 * Thin route over store.listTurnResults; restored for the e2e-plugin-verify
 * harness which polls it after every action to assert commit outcomes.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { sessionTurnRoutes } from "../../src/routes/api/session-turns.js";

async function makeApp(): Promise<{ app: Hono; store: DataStore }> {
  const store = createMemoryStore();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store" as never, store as never);
    await next();
  });
  app.route("/api/sessions", sessionTurnRoutes);
  return { app, store };
}

describe("GET /api/sessions/:id/turns", () => {
  it("lists persisted turn artifacts with their commit status", async () => {
    const { app, store } = await makeApp();
    await store.createSession({
      id: "sess-turns",
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      activePlugins: [],
      locale: "zh-CN",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.saveTurnResult({
      id: crypto.randomUUID(),
      sessionId: "sess-turns",
      turnId: "turn-1",
      runtimeResults: [],
      origin: "player",
      commitStatus: "committed",
      durationMs: 5,
      createdAt: new Date().toISOString(),
    });

    const res = await app.request("/api/sessions/sess-turns/turns");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      turns: Array<{ turnId: string; commitStatus: string }>;
    };
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0]).toMatchObject({
      turnId: "turn-1",
      commitStatus: "committed",
    });
  });

  it("404s for an unknown session", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/sessions/nope/turns");
    expect(res.status).toBe(404);
  });
});
