import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import {
  getSessionExecutionStatus,
  assertRecoverableTurn,
  recoveryAction,
} from "../../src/routes/api/actions/execution-recovery.js";
import { registerActiveTurn } from "../../src/routes/api/turn-control.js";

async function fixture() {
  const store = createMemoryStore();
  await store.createSession({
    id: "recovery",
    status: "active",
    phase: "playing",
    activePlugins: [],
    completedPlayerTurns: 0,
    setupRuntimes: {},
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const trace = async (
    type: string,
    payload: Record<string, unknown> = {},
    turnId = "opening",
  ) => {
    await store.addTraceEvent({
      id: crypto.randomUUID(),
      sessionId: "recovery",
      turnId,
      traceId: turnId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    });
  };
  return { store, trace };
}

describe("foreground execution recovery", () => {
  it("reports an interrupted legacy opening without mutating its trace", async () => {
    const { store, trace } = await fixture();
    await store.addTraceEvent({
      id: "setup-start",
      sessionId: "recovery",
      turnId: "setup",
      traceId: "opening",
      type: "turn.started",
      payload: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.saveTurnResult({
      id: "setup-result",
      sessionId: "recovery",
      turnId: "setup",
      runtimeResults: [],
      durationMs: 1,
      createdAt: "2026-01-01T00:00:00.001Z",
      commitStatus: "committed",
    });
    await trace("turn.started");
    await trace("runtime.started", { runtimeId: "story" });
    expect(await getSessionExecutionStatus(store, "recovery")).toMatchObject({
      state: "interrupted",
      turnId: "opening",
      retry: { type: "retry_turn", payload: {} },
    });
    expect(
      (await store.listTraceEvents("recovery")).map((event) => event.type),
    ).toEqual(["turn.started", "turn.started", "runtime.started"]);
  });

  it("returns running throughout execution and abort settlement without exposing steering", async () => {
    const { store } = await fixture();
    const turn = registerActiveTurn("recovery", "active", "request");
    try {
      expect(await getSessionExecutionStatus(store, "recovery")).toEqual({
        state: "running",
        turnId: "active",
        requestId: "request",
        startedAt: expect.any(String),
      });
      await expect(
        assertRecoverableTurn(store, "recovery", "active"),
      ).rejects.toThrow("no longer available");
    } finally {
      turn.release();
    }
  });

  it("finds the opening marker beyond a large trace page and retains original input", async () => {
    const { store, trace } = await fixture();
    await store.addTraceEvent({
      id: "start",
      sessionId: "recovery",
      turnId: "opening",
      traceId: "opening",
      type: "turn.started",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        recoveryAction: recoveryAction("send_message", {
          content: "Open the door",
          unexpectedKey: "discard",
        }),
      },
    });
    for (let i = 0; i < 205; i++)
      await trace("llm.responded", { runtimeId: "story" });
    expect(await getSessionExecutionStatus(store, "recovery")).toMatchObject({
      state: "interrupted",
      retry: { type: "send_message", payload: { content: "Open the door" } },
    });
    await expect(
      assertRecoverableTurn(store, "recovery", "opening"),
    ).resolves.toMatchObject({ state: "interrupted" });
    await expect(
      assertRecoverableTurn(store, "recovery", "other"),
    ).rejects.toThrow();
    await expect(
      assertRecoverableTurn(store, "recovery", "opening", {
        type: "send_message",
        payload: { content: "Changed input" },
      }),
    ).rejects.toThrow();
  });

  it("uses a durable commit even when the terminal trace was lost", async () => {
    const { store, trace } = await fixture();
    await trace("turn.started");
    await store.saveTurnResult({
      id: "result",
      sessionId: "recovery",
      turnId: "opening",
      runtimeResults: [],
      durationMs: 15,
      createdAt: new Date().toISOString(),
      commitStatus: "committed",
    });
    expect(await getSessionExecutionStatus(store, "recovery")).toMatchObject({
      state: "completed",
    });
    await expect(
      assertRecoverableTurn(store, "recovery", "opening"),
    ).rejects.toThrow();
  });

  it("does not treat a failed commit's completed trace as success", async () => {
    const { store, trace } = await fixture();
    await trace("turn.started", {
      recoveryAction: recoveryAction("start_session", {}),
    });
    await trace("turn.completed", { committed: false });
    expect(await getSessionExecutionStatus(store, "recovery")).toMatchObject({
      state: "failed",
      retry: { type: "start_session", payload: {} },
    });
  });

  it("does not guess the missing input of a legacy player turn", async () => {
    const { store, trace } = await fixture();
    await store.updateSession("recovery", { completedPlayerTurns: 0 });
    await trace("turn.started");
    const status = await getSessionExecutionStatus(store, "recovery");
    expect(status.state).toBe("interrupted");
    expect(status.retry).toBeUndefined();
  });
});
