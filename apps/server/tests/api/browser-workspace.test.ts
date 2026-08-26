import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createMemoryStore,
  exportSessionCheckpoint,
  type DataStore,
  type SessionCommit,
} from "@covel/store";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createBrowserWorkspaceRoutes } from "../../src/routes/api/browser-workspace.js";

const SESSION_ID = "browser-session";
const WORLD_ID = "browser-world";

let store: DataStore;
let app: Hono;

async function seed(target: DataStore, metadata?: Record<string, unknown>) {
  await target.upsertWorld({
    id: WORLD_ID,
    name: "Browser World",
    description: "",
    createdAt: "2026-08-25T00:00:00.000Z",
  });
  await target.createSession({
    phase: "playing",
    setupRuntimes: {},
    id: SESSION_ID,
    worldId: WORLD_ID,
    status: "active",
    completedPlayerTurns: 0,

    activePlugins: [],
    locale: "zh-CN",
    metadata,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  });
}

async function upload(checkpoint: unknown): Promise<Response> {
  return app.request(`/api/sessions/${SESSION_ID}/browser-checkpoint`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ checkpoint }),
  });
}

beforeEach(async () => {
  store = createMemoryStore();
  await seed(store, { ownerTokenHash: "server-private" });
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("storeBackend", "memory");
    c.set("sessionLock", createInProcessSessionLock());
    await next();
  });
  app.route("/api/sessions", createBrowserWorkspaceRoutes());
});

describe("browser-private workspace exchange", () => {
  it("hydrates all checkpoint domains and preserves server-private metadata", async () => {
    const browser = createMemoryStore();
    await seed(browser, { player: "local" });
    await browser.addMessage({
      id: "message-1",
      sessionId: SESSION_ID,
      role: "user",
      content: "hello",
      createdAt: "2026-08-25T00:00:01.000Z",
    });
    const checkpoint = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 1,
      actionId: "bootstrap",
    });

    expect((await upload(checkpoint)).status).toBe(200);
    expect((await store.listMessages(SESSION_ID))[0]?.content).toBe("hello");
    expect((await store.getSession(SESSION_ID))?.metadata).toEqual({
      player: "local",
      ownerTokenHash: "server-private",
    });
  });

  it("returns an idempotent post-action commit and advances revision once", async () => {
    const browser = createMemoryStore();
    await seed(browser);
    const checkpoint = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 1,
      actionId: "bootstrap",
    });
    expect((await upload(checkpoint)).status).toBe(200);
    await store.addMessage({
      id: "message-2",
      sessionId: SESSION_ID,
      role: "assistant",
      content: "world",
      createdAt: "2026-08-25T00:00:02.000Z",
    });

    const request = () =>
      app.request(`/api/sessions/${SESSION_ID}/browser-commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "turn-1", baseRevision: 1 }),
      });
    const first = await request();
    const firstCommit = (await first.json()) as SessionCommit;
    const replay = await request();
    const replayCommit = (await replay.json()) as SessionCommit;

    expect(first.status).toBe(200);
    expect(firstCommit.revision).toBe(2);
    expect(firstCommit.checkpoint.messages).toHaveLength(1);
    expect(replayCommit).toEqual(firstCommit);
  });

  it("rejects a stale browser upload", async () => {
    const browser = createMemoryStore();
    await seed(browser);
    const first = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 2,
      actionId: "local-2",
    });
    expect((await upload(first)).status).toBe(200);
    const stale = { ...first, revision: 1, actionId: "local-1" };
    expect((await upload(stale)).status).toBe(409);
  });

  it("rejects a different checkpoint head at the same revision", async () => {
    const browser = createMemoryStore();
    await seed(browser);
    const first = await exportSessionCheckpoint(browser, SESSION_ID, {
      revision: 1,
      actionId: "local-a",
    });
    expect((await upload(first)).status).toBe(200);

    expect((await upload({ ...first, actionId: "local-b" })).status).toBe(409);
  });
});
