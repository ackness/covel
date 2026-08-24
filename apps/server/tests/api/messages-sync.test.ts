import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createMemoryStore,
  type DataStore,
  type StoreTransaction,
} from "@covel/store";
import { messageRoutes } from "../../src/routes/api/messages.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

describe("POST /api/sessions/:id/messages/sync", () => {
  it("rolls back the whole batch when one message write fails", async () => {
    const base = createMemoryStore();
    await base.createSession({
      id: "s",
      worldId: "w",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      activePlugins: [],
      createdAt: new Date().toISOString(),
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
});
