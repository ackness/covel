import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { actionRoutes } from "../../src/routes/api/actions.js";
import {
  abortActiveTurn,
  getActiveTurn,
} from "../../src/routes/api/turn-control.js";
import { createBootstrapMemorySystem } from "../../src/routes/api/bootstrap/memory.js";
import { parseJsonFrames } from "./sse-test-utils.js";

describe("action cancellation during memory recovery", () => {
  it("settles the action and releases its session lock while prior memory still finishes durably", async () => {
    const store = createMemoryStore();
    const sessionId = "memory-abort-session";
    await store.createSession({
      id: sessionId,
      worldId: null,
      phase: "playing",
      status: "active",
      activePlugins: [],
      setupRuntimes: {},
      completedPlayerTurns: 1,
      metadata: {
        approvalScopeNonce: "scope",
        sessionIncarnationNonce: "incarnation",
      },
      createdAt: new Date().toISOString(),
    });
    const memoryStarted = Promise.withResolvers<void>();
    const releaseMemory = Promise.withResolvers<void>();
    const memory = createBootstrapMemorySystem({
      store,
      manifestCache: new Map(),
      resolveModel: () => "memory",
      llmAdapter: {
        generate: async () => {
          memoryStarted.resolve();
          await releaseMemory.promise;
          return {
            content: '{"story_state":"The previous turn remains recorded."}',
            toolCalls: [],
            finishReason: "stop",
          };
        },
      },
    })!.memorySystem;
    await store.withTransaction((tx) =>
      memory.updater.stageAfterTurn!(tx, {
        sessionId,
        turnId: "previous-turn",
        narrativeText: "The previous turn.",
        currentBlocks: [],
      }),
    );
    const background = memory.updater.awaitPending(sessionId);
    await memoryStarted.promise;
    const awaitingMemory = Promise.withResolvers<void>();
    const awaitPending = memory.updater.awaitPending.bind(memory.updater);
    vi.spyOn(memory.updater, "awaitPending").mockImplementation((id) => {
      awaitingMemory.resolve();
      return awaitPending(id);
    });
    const sessionLock = createInProcessSessionLock();
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("eventBus", createEventBus(store));
      c.set("pluginRegistry", createPluginRegistry());
      c.set("sessionLock", sessionLock);
      c.set("memorySystem", memory);
      c.set("llmAdapter", {
        generate: async () => ({
          content: "",
          toolCalls: [],
          finishReason: "stop",
        }),
      });
      c.set("resolveModel", () => undefined);
      await next();
    });
    app.route("/api/actions", actionRoutes);
    const response = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "stop-memory-wait",
        sessionId,
        type: "send_message",
        payload: { content: "Do not commit this action." },
      }),
    });
    let settled = false;
    const stream = response.text().then((body) => {
      settled = true;
      return body;
    });
    try {
      await awaitingMemory.promise;
      expect(abortActiveTurn(sessionId)).not.toBeNull();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
      const frames = parseJsonFrames<{ type: string; payload?: unknown }>(
        await stream,
      );
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "execution.completed",
          payload: expect.objectContaining({
            abortReason: "aborted-by-player",
            committed: false,
          }),
        }),
      );
      expect(getActiveTurn(sessionId)).toBeNull();
      await sessionLock.withLock(sessionId, async () => {
        expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(
          1,
        );
        expect(await store.listTurnMessages(sessionId)).toEqual([]);
      });
      expect(
        await store.listPluginData(sessionId, "__memory", "_pending_updates"),
      ).toHaveLength(1);
    } finally {
      releaseMemory.resolve();
      await Promise.all([background, stream]);
      await awaitPending(sessionId);
    }
    expect(
      await store.listPluginData(sessionId, "__memory", "_pending_updates"),
    ).toEqual([]);
    expect(await memory.manager.loadBlocks(sessionId)).toContainEqual(
      expect.objectContaining({
        label: "story_state",
        content: "The previous turn remains recorded.",
      }),
    );
  });
});
