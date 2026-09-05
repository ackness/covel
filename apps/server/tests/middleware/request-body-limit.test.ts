import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createMemoryStore,
  exportSessionCheckpoint,
  type DataStore,
} from "@covel/store";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  BROWSER_CHECKPOINT_BODY_LIMIT_BYTES,
  DEFAULT_BODY_LIMIT_BYTES,
  INSTALL_BODY_LIMIT_BYTES,
  createRequestBodyLimitMiddleware,
} from "../../src/middleware/request-body-limit.js";
import { createBrowserWorkspaceRoutes } from "../../src/routes/api/browser-workspace.js";
import { hashSessionOwnerToken } from "../../src/routes/api/session/session-guard.js";

const CHECKPOINT_PATH = "/api/sessions/body-limit-session/browser-checkpoint";

function createApp() {
  const app = new Hono();
  app.use("*", createRequestBodyLimitMiddleware());
  app.all("*", (c) => c.body(null, 204));
  return app;
}

function sizedStream(byteLength: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  let remaining = byteLength;
  return new ReadableStream({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const size = Math.min(chunk.length, remaining);
      controller.enqueue(chunk.subarray(0, size));
      remaining -= size;
    },
  });
}

describe("request body limits", () => {
  it.each([
    [BROWSER_CHECKPOINT_BODY_LIMIT_BYTES, 204],
    [BROWSER_CHECKPOINT_BODY_LIMIT_BYTES + 1, 413],
  ])(
    "checks the checkpoint Content-Length boundary at %i bytes",
    async (size, status) => {
      const response = await createApp().request(CHECKPOINT_PATH, {
        method: "PUT",
        headers: { "content-length": String(size) },
        body: "{}",
      });
      expect(response.status).toBe(status);
    },
  );

  it.each([
    [BROWSER_CHECKPOINT_BODY_LIMIT_BYTES, 204],
    [BROWSER_CHECKPOINT_BODY_LIMIT_BYTES + 1, 413],
  ])(
    "checks the streamed checkpoint boundary at %i bytes without Content-Length",
    async (size, status) => {
      const request = new Request(`http://localhost${CHECKPOINT_PATH}`, {
        method: "PUT",
        body: sizedStream(size),
        duplex: "half",
      } as RequestInit);
      const response = await createApp().request(request);
      expect(response.status).toBe(status);
    },
  );

  it.each([
    ["POST", CHECKPOINT_PATH],
    ["PATCH", CHECKPOINT_PATH],
    ["PUT", `${CHECKPOINT_PATH}/`],
    ["PUT", `${CHECKPOINT_PATH}/extra`],
    ["PUT", `${CHECKPOINT_PATH}-extra`],
    ["PUT", "/api/sessions/body-limit-session/nested/browser-checkpoint"],
    ["PUT", "/api/sessions//browser-checkpoint"],
    ["POST", "/api/sessions/body-limit-session/browser-commit"],
    ["POST", "/api/sessions/body-limit-session/actions"],
  ])("keeps the ordinary cap for %s %s", async (method, path) => {
    const response = await createApp().request(path, {
      method,
      body: "x".repeat(DEFAULT_BODY_LIMIT_BYTES + 1),
    });
    expect(response.status).toBe(413);
  });

  it.each(["/api/install", "/api/install/worlds", "/api/media"])(
    "preserves the upload cap for %s",
    async (path) => {
      const app = createApp();
      const accepted = await app.request(path, {
        method: "POST",
        body: "x".repeat(DEFAULT_BODY_LIMIT_BYTES + 1),
      });
      const rejected = await app.request(path, {
        method: "POST",
        headers: { "content-length": String(INSTALL_BODY_LIMIT_BYTES + 1) },
        body: "x",
      });
      expect(accepted.status).toBe(204);
      expect(rejected.status).toBe(413);
    },
  );

  it("hydrates a complete checkpoint larger than 1 MiB", async () => {
    const sessionId = "body-limit-session";
    const ownerToken = "test-body-limit-owner";
    const browser = createMemoryStore();
    const server = createMemoryStore();
    async function seed(store: DataStore, owned: boolean) {
      await store.upsertWorld({
        id: "body-limit-world",
        name: "Body limit world",
        description: "",
        createdAt: "2026-08-25T00:00:00.000Z",
      });
      await store.createSession({
        id: sessionId,
        worldId: "body-limit-world",
        phase: "playing",
        status: "active",
        setupRuntimes: {},
        completedPlayerTurns: 0,
        activePlugins: [],
        locale: "zh-CN",
        metadata: owned
          ? { ownerTokenHash: hashSessionOwnerToken(ownerToken) }
          : undefined,
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
      });
    }
    await seed(browser, false);
    await seed(server, true);
    for (let index = 0; index < 180; index += 1) {
      await browser.addMessage({
        id: `message-${index}`,
        sessionId,
        role: "user",
        content: "x".repeat(6000),
        createdAt: "2026-08-25T00:00:01.000Z",
      });
    }
    const checkpoint = await exportSessionCheckpoint(browser, sessionId, {
      revision: 1,
      actionId: "large-checkpoint",
    });
    const body = JSON.stringify({ checkpoint });
    expect(Buffer.byteLength(body)).toBeGreaterThan(DEFAULT_BODY_LIMIT_BYTES);

    const app = new Hono();
    app.use("*", createRequestBodyLimitMiddleware());
    const sessionLock = createInProcessSessionLock();
    app.use("*", async (c, next) => {
      c.set("store", server);
      c.set("storeBackend", "memory");
      c.set("sessionLock", sessionLock);
      await next();
    });
    app.route("/api/sessions", createBrowserWorkspaceRoutes());

    const response = await app.request(`${CHECKPOINT_PATH}?restore=1`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-session-token": ownerToken,
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, revision: 1 });
    const messages = await server.listMessages(sessionId);
    expect(messages).toHaveLength(180);
    expect(messages.every((message) => message.content.length === 6000)).toBe(
      true,
    );
  });
});
