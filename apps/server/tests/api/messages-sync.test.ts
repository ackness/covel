import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { type DataStore, type StoreTransaction } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { messageRoutes } from "../../src/routes/api/messages.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

describe("POST /api/sessions/:id/messages/sync", () => {
  it("is idempotent when the local client retries stable message ids", async () => {
    const store = createMemoryStore();
    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: "s",
      worldId: "w",
      status: "active",
      locale: "zh-CN",
      completedPlayerTurns: 0,

      activePlugins: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const app = new Hono();
    const sessionLock = createInProcessSessionLock();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("sessionLock", sessionLock);
      await next();
    });
    app.route("/api/sessions", messageRoutes);
    const request = {
      method: "POST" as const,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            id: "local-m1",
            role: "user",
            content: "one",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "local-m2",
            role: "assistant",
            content: "two",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ],
      }),
    };

    expect(
      (await app.request("/api/sessions/s/messages/sync", request)).status,
    ).toBe(200);
    expect(
      (await app.request("/api/sessions/s/messages/sync", request)).status,
    ).toBe(200);

    const messages = await store.listMessages("s");
    expect(messages.map((message) => message.id)).toEqual([
      "local-m1",
      "local-m2",
    ]);
    expect(messages.map((message) => message.createdAt)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
    ]);

    const response = await app.request("/api/sessions/s/messages");
    expect(await response.json()).toMatchObject({
      items: [
        { id: "local-m1", content: "one" },
        { id: "local-m2", content: "two" },
      ],
    });
  });

  it("rolls back the whole batch when one message write fails", async () => {
    const base = createMemoryStore();
    await base.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: "s",
      worldId: "w",
      status: "active",
      locale: "zh-CN",
      completedPlayerTurns: 0,

      activePlugins: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const store = new Proxy(base, {
      get(target, property, receiver) {
        if (property !== "withTransaction")
          return Reflect.get(target, property, receiver);
        return async (fn: (tx: StoreTransaction) => Promise<unknown>) =>
          base.withTransaction!(async (tx) => {
            let writes = 0;
            const failingTx = new Proxy(tx, {
              get(txTarget, txProperty, txReceiver) {
                if (txProperty !== "addMessage")
                  return Reflect.get(txTarget, txProperty, txReceiver);
                return async (
                  ...args: Parameters<StoreTransaction["addMessage"]>
                ) => {
                  writes += 1;
                  if (writes === 2)
                    throw new Error("injected second-write failure");
                  return tx.addMessage(...args);
                };
              },
            });
            return fn(failingTx);
          });
      },
    }) as DataStore;
    const app = new Hono();
    const sessionLock = createInProcessSessionLock();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("sessionLock", sessionLock);
      await next();
    });
    app.route("/api/sessions", messageRoutes);

    const response = await app.request("/api/sessions/s/messages/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { id: "m1", role: "user", content: "one" },
          { id: "m2", role: "assistant", content: "two" },
        ],
      }),
    });

    expect(response.status).toBe(500);
    expect(await base.listMessages("s")).toEqual([]);
  });

  it("skips stored and repeated ids without reading the session's history", async () => {
    const base = createMemoryStore();
    await base.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: "s",
      worldId: "w",
      status: "active",
      locale: "zh-CN",
      completedPlayerTurns: 0,

      activePlugins: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await base.addMessage({
      id: "stored",
      sessionId: "s",
      role: "user",
      content: "kept",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    let fullReads = 0;
    const store = new Proxy(base, {
      get(target, property, receiver) {
        if (property !== "withTransaction")
          return Reflect.get(target, property, receiver);
        return async (fn: (tx: StoreTransaction) => Promise<unknown>) =>
          base.withTransaction!(async (tx) =>
            fn(
              new Proxy(tx, {
                get(txTarget, txProperty, txReceiver) {
                  if (txProperty === "listMessages") fullReads += 1;
                  return Reflect.get(txTarget, txProperty, txReceiver);
                },
              }),
            ),
          );
      },
    }) as DataStore;
    const app = new Hono();
    const sessionLock = createInProcessSessionLock();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("sessionLock", sessionLock);
      await next();
    });
    app.route("/api/sessions", messageRoutes);

    const response = await app.request("/api/sessions/s/messages/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { id: "stored", role: "user", content: "changed" },
          { id: "new", role: "assistant", content: "first" },
          { id: "new", role: "assistant", content: "second" },
          { role: "assistant", content: "no id" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(fullReads).toBe(0);
    expect(
      (await base.listMessages("s")).map((message) => message.content).sort(),
    ).toEqual(["first", "kept", "no id"]);
  });
});
