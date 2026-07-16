/**
 * W4 turn-control registry + steer/abort routes.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import {
  abortActiveTurn,
  awaitActiveTurnsDrained,
  hasActiveTurn,
  registerActiveTurn,
  steerActiveTurn,
} from "../../src/routes/api/turn-control.js";
import { turnControlRoutes } from "../../src/routes/api/turn-control-routes.js";

describe("turn-control registry", () => {
  it("registers, steers, aborts, and releases an active turn", () => {
    const { turnControl, release } = registerActiveTurn("sess-1", "turn-1");

    expect(steerActiveTurn("sess-1", "hello")).toEqual({ turnId: "turn-1" });
    expect(turnControl.drainSteering?.()).toEqual(["hello"]);
    // Drained — queue is empty on the next call.
    expect(turnControl.drainSteering?.()).toEqual([]);

    expect(turnControl.signal?.aborted).toBe(false);
    expect(abortActiveTurn("sess-1")).toEqual({ turnId: "turn-1" });
    expect(turnControl.signal?.aborted).toBe(true);
    // An aborted turn no longer accepts steering.
    expect(steerActiveTurn("sess-1", "late")).toBeNull();

    release();
    expect(hasActiveTurn("sess-1")).toBe(false);
    expect(abortActiveTurn("sess-1")).toBeNull();
  });

  it("a newer registration replaces a stale one; stale release is a no-op", () => {
    const first = registerActiveTurn("sess-2", "turn-a");
    const second = registerActiveTurn("sess-2", "turn-b");

    expect(steerActiveTurn("sess-2", "for-b")).toEqual({ turnId: "turn-b" });
    // Releasing the stale first registration must not remove the live one.
    first.release();
    expect(hasActiveTurn("sess-2")).toBe(true);
    second.release();
    expect(hasActiveTurn("sess-2")).toBe(false);
  });

  it("awaitActiveTurnsDrained resolves once turns release, and honors the deadline (L-6)", async () => {
    // Resolves immediately when nothing is in flight.
    await awaitActiveTurnsDrained(1000);

    const turn = registerActiveTurn("sess-drain", "turn-d");
    expect(hasActiveTurn("sess-drain")).toBe(true);
    // Release shortly after; the wait must resolve once the turn is gone.
    setTimeout(() => turn.release(), 20);
    await awaitActiveTurnsDrained(1000, 5);
    expect(hasActiveTurn("sess-drain")).toBe(false);

    // A turn that never releases must not hang the wait past the deadline.
    const stuck = registerActiveTurn("sess-stuck", "turn-s");
    const start = Date.now();
    await awaitActiveTurnsDrained(60, 5);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(hasActiveTurn("sess-stuck")).toBe(true);
    stuck.release();
  });
});

describe("steer/abort routes", () => {
  async function makeApp(): Promise<{
    app: Hono;
    store: DataStore;
  }> {
    const store = createMemoryStore();
    await store.createSession({
      id: "sess-r",
      worldId: "w",
      status: "active",
      turnCount: 1,
      activePlugins: [],
      preGameCompleted: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store" as never, store as never);
      await next();
    });
    app.route("/api/sessions", turnControlRoutes);
    return { app, store };
  }

  it("409s when no turn is active; 404s on unknown session; 400s on bad body", async () => {
    const { app } = await makeApp();

    const noTurn = await app.request("/api/sessions/sess-r/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(noTurn.status).toBe(409);

    const noSession = await app.request("/api/sessions/nope/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(noSession.status).toBe(404);

    const badBody = await app.request("/api/sessions/sess-r/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(badBody.status).toBe(400);

    const abortNoTurn = await app.request("/api/sessions/sess-r/abort", {
      method: "POST",
    });
    expect(abortNoTurn.status).toBe(409);
  });

  it("retracts the queued interjection when persistence fails", async () => {
    const { store } = await makeApp();
    const failing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "addMessage") {
          return () => Promise.reject(new Error("disk full"));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const appFailing = new Hono();
    appFailing.use("*", async (c, next) => {
      c.set("store" as never, failing as never);
      await next();
    });
    appFailing.route("/api/sessions", turnControlRoutes);

    const { turnControl, release } = registerActiveTurn("sess-r", "turn-r");
    try {
      const res = await appFailing.request("/api/sessions/sess-r/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "lost write" }),
      });
      expect(res.status).toBe(500);
      // Queue and history stay consistent: nothing left for the loop to drain.
      expect(turnControl.drainSteering?.()).toEqual([]);
    } finally {
      release();
    }
  });

  it("steers and aborts an active turn; steered message is persisted", async () => {
    const { app, store } = await makeApp();
    const { turnControl, release } = registerActiveTurn("sess-r", "turn-r");
    try {
      const steer = await app.request("/api/sessions/sess-r/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "take the left path" }),
      });
      expect(steer.status).toBe(200);
      expect(turnControl.drainSteering?.()).toEqual(["take the left path"]);

      const messages = await store.listMessages("sess-r");
      expect(
        messages.some(
          (m) => m.role === "user" && m.content === "take the left path",
        ),
      ).toBe(true);

      const abort = await app.request("/api/sessions/sess-r/abort", {
        method: "POST",
      });
      expect(abort.status).toBe(200);
      expect(turnControl.signal?.aborted).toBe(true);
    } finally {
      release();
    }
  });
});
