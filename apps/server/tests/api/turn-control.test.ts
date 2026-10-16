/**
 * Turn-control registry + steer/abort routes.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import {
  abortActiveTurn,
  hasActiveTurn,
  registerActionRequest,
  steerActiveTurn,
} from "../../src/routes/api/turn-control.js";
import { turnControlRoutes } from "../../src/routes/api/turn-control-routes.js";

describe("turn-control registry", () => {
  it("registers, steers, aborts, and releases an active turn", () => {
    const request = registerActionRequest("sess-1", "turn-1");
    const turnControl = request.beginTurn("turn-1");

    expect(steerActiveTurn("sess-1", "hello")).toEqual({ turnId: "turn-1" });
    expect(turnControl.drainSteering?.()).toEqual(["hello"]);
    // Drained — queue is empty on the next call.
    expect(turnControl.drainSteering?.()).toEqual([]);

    expect(turnControl.signal?.aborted).toBe(false);
    expect(abortActiveTurn("sess-1")).toEqual({ turnId: "turn-1" });
    expect(turnControl.signal?.aborted).toBe(true);
    // An aborted turn no longer accepts steering.
    expect(steerActiveTurn("sess-1", "late")).toEqual({
      refused: "steering_closed",
    });

    request.release();
    expect(hasActiveTurn("sess-1")).toBe(false);
    expect(abortActiveTurn("sess-1")).toBeNull();
    expect(steerActiveTurn("sess-1", "after")).toEqual({
      refused: "no_active_turn",
    });
  });

  it("hands every accepted interjection to the commit, read or not", () => {
    const request = registerActionRequest("sess-i", "turn-i");
    const turnControl = request.beginTurn("turn-i");
    try {
      steerActiveTurn("sess-i", "first");
      expect(turnControl.drainSteering?.()).toEqual(["first"]);
      steerActiveTurn("sess-i", "second");

      const saved = request.closeInterjections();
      expect(saved).toEqual([
        { content: "first", readAt: expect.any(String) },
        { content: "second" },
      ]);
      // After the commit took them, a late one is refused, not lost.
      expect(steerActiveTurn("sess-i", "too late")).toEqual({
        refused: "steering_closed",
      });
    } finally {
      request.release();
    }
  });

  it("refuses steering once the executor closed the queue", () => {
    const request = registerActionRequest("sess-c", "turn-c");
    const turnControl = request.beginTurn("turn-c");
    try {
      expect(steerActiveTurn("sess-c", "in time")).toEqual({
        turnId: "turn-c",
      });
      turnControl.closeSteering?.();

      // The turn is still registered (bookkeeping, commit), but nothing reads
      // the queue any more, so a new interjection is not queued.
      expect(hasActiveTurn("sess-c")).toBe(true);
      expect(steerActiveTurn("sess-c", "too late")).toEqual({
        refused: "steering_closed",
      });
      expect(turnControl.drainSteering?.()).toEqual(["in time"]);
    } finally {
      request.release();
    }
  });

  it("a newer registration replaces a stale one; stale release is a no-op", () => {
    const first = registerActionRequest("sess-2", "turn-a");
    first.beginTurn("turn-a");
    const second = registerActionRequest("sess-2", "turn-b");
    second.beginTurn("turn-b");

    expect(steerActiveTurn("sess-2", "for-b")).toEqual({ turnId: "turn-b" });
    // Releasing the stale first registration must not remove the live one.
    first.release();
    expect(hasActiveTurn("sess-2")).toBe(true);
    second.release();
    expect(hasActiveTurn("sess-2")).toBe(false);
  });
});

describe("turn-control action requests", () => {
  it("a stop reaches a request still waiting to start its turn", () => {
    const request = registerActionRequest("sess-w", "turn-w", "req-w");
    try {
      // Waiting is not running: the execution status stays idle.
      expect(hasActiveTurn("sess-w")).toBe(false);
      expect(abortActiveTurn("sess-w")).toEqual({ turnId: "turn-w" });
      expect(request.signal.aborted).toBe(true);
    } finally {
      request.release();
    }
    expect(abortActiveTurn("sess-w")).toBeNull();
  });

  it("a stop targets the running turn, not a request queued behind it", () => {
    const running = registerActionRequest("sess-q", "turn-1");
    const queued = registerActionRequest("sess-q", "turn-2");
    try {
      running.beginTurn("turn-1");
      expect(abortActiveTurn("sess-q")).toEqual({ turnId: "turn-1" });
      expect(running.signal.aborted).toBe(true);
      expect(queued.signal.aborted).toBe(false);
    } finally {
      running.release();
      queued.release();
    }
  });

  it("one stop covers every turn the request chains", () => {
    const request = registerActionRequest("sess-c2", "setup-turn");
    try {
      const setup = request.beginTurn("setup-turn");
      // Between the setup turn and the opening, the request is still the target.
      expect(abortActiveTurn("sess-c2")).toEqual({ turnId: "setup-turn" });
      const opening = request.beginTurn("opening-turn");
      expect(setup.signal?.aborted).toBe(true);
      expect(opening.signal?.aborted).toBe(true);
    } finally {
      request.release();
    }
  });

  it("a finished request has nothing to stop or steer", () => {
    const request = registerActionRequest("sess-f", "turn-f");
    try {
      request.beginTurn("turn-f");
      request.finish();
      // Still running for the execution status until the stream ends.
      expect(hasActiveTurn("sess-f")).toBe(true);
      expect(abortActiveTurn("sess-f")).toBeNull();
      expect(request.signal.aborted).toBe(false);
      expect(steerActiveTurn("sess-f", "late")).toEqual({
        refused: "no_active_turn",
      });
    } finally {
      request.release();
    }
  });
});

describe("steer/abort routes", () => {
  async function makeApp(): Promise<{
    app: Hono;
    store: DataStore;
  }> {
    const store = createMemoryStore();
    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: "sess-r",
      worldId: "w",
      status: "active",
      locale: "zh-CN",
      completedPlayerTurns: 1,
      activePlugins: [],

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
    expect(await noTurn.json()).toMatchObject({ code: "no_active_turn" });

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

  it("409s with steering_closed and stores nothing once the queue is closed", async () => {
    const { app, store } = await makeApp();
    const request = registerActionRequest("sess-r", "turn-r");
    const turnControl = request.beginTurn("turn-r");
    try {
      turnControl.closeSteering?.();

      const res = await app.request("/api/sessions/sess-r/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "one more thing" }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "steering_closed" });
      // Refused text is neither queued nor shown in the chat log as sent.
      expect(turnControl.drainSteering?.()).toEqual([]);
      expect(await store.listMessages("sess-r")).toEqual([]);
    } finally {
      request.release();
    }
  });

  it("steers and aborts an active turn; the interjection waits for the turn's commit", async () => {
    const { app, store } = await makeApp();
    const request = registerActionRequest("sess-r", "turn-r");
    const turnControl = request.beginTurn("turn-r");
    try {
      const steer = await app.request("/api/sessions/sess-r/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "take the left path" }),
      });
      expect(steer.status).toBe(200);
      // The client stamps its local echo with this turn.
      expect(await steer.json()).toEqual({ ok: true, turnId: "turn-r" });
      expect(turnControl.drainSteering?.()).toEqual(["take the left path"]);

      // Nothing is written outside the turn: its commit saves the text.
      expect(await store.listMessages("sess-r")).toEqual([]);
      expect(request.closeInterjections()).toEqual([
        { content: "take the left path", readAt: expect.any(String) },
      ]);

      const abort = await app.request("/api/sessions/sess-r/abort", {
        method: "POST",
      });
      expect(abort.status).toBe(200);
      expect(turnControl.signal?.aborted).toBe(true);
    } finally {
      request.release();
    }
  });
});
