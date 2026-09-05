import { describe, expect, it } from "vitest";
import type { SseEnvelope } from "@/services/api.js";
import { initialState, reducer } from "../reducer.js";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../sse-handler.js";
import { projectExecutionTurns } from "../execution-projection.js";
import type { SessionAction } from "../types.js";

function harness(retrying = true) {
  let state = {
    ...initialState,
    executing: true,
    executionSteps: [
      {
        runtimeId: "tracker",
        pluginId: "tracker",
        turnId: "source",
        status: "failed" as const,
        attemptStatus: "committed" as const,
        startedAt: "2026-09-05T00:00:00Z",
      },
    ],
  } as typeof initialState;
  const deps: SseEventHandlerDeps = {
    dispatch: (action: SessionAction) => {
      state = reducer(state, action);
    },
    ds: {} as SseEventHandlerDeps["ds"],
    sessionIdRef: { current: "session" },
    // Intentionally not updated: React may batch every event before rendering.
    stateRef: { current: state },
    runtimeKindRef: { current: new Map() },
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    lastBackfilledTurnIdRef: { current: "attempt" },
  };
  const handler = createSseEventHandler(deps);
  return {
    getState: () => state,
    send: (type: string, payload: Record<string, unknown>) =>
      handler({
        type,
        eventId: type,
        requestId: "request",
        traceId: "trace",
        flowId: "flow",
        seq: 1,
        sessionId: "session",
        turnId: "attempt",
        timestamp: "2026-09-05T01:00:00Z",
        payload: {
          ...(retrying
            ? { sourceTurnId: "source", runtimeIds: ["tracker"] }
            : {}),
          runtimeId: "tracker",
          pluginId: "tracker",
          ...payload,
        },
      } as SseEnvelope),
  };
}

describe("SSE retry commit settlement", () => {
  it("atomically replaces the inflight failure summary and ignores a late replay", () => {
    const h = harness();
    const inflight = {
      sourceCommitted: true,
      sourceFailedRuntimeIds: ["tracker", "remaining"],
    };
    h.send("runtime.started", inflight);
    h.send("runtime.completed", { ...inflight, status: "success" });
    h.send("execution.completed", {
      committed: true,
      sourceCommitted: true,
      sourceFailedRuntimeIds: ["remaining"],
    });
    h.send("runtime.completed", { ...inflight, status: "success" });
    expect(h.getState().executionSteps[1].sourceFailedRuntimeIds).toEqual([
      "remaining",
    ]);
    expect(
      projectExecutionTurns(
        [],
        h.getState().executionSteps,
      ).latestTurn?.steps.map((step) => [step.runtimeId, step.status]),
    ).toEqual([
      ["tracker", "completed"],
      ["remaining", "failed"],
    ]);
  });
  it("preserves a committed result after late transport errors or repeated runtime events", () => {
    const h = harness();
    h.send("runtime.started", {});
    h.send("runtime.completed", { status: "success" });
    h.send("execution.completed", { committed: true });
    h.send("error.occurred", { message: "Trace write failed" });
    h.send("runtime.completed", { status: "success" });
    expect(h.getState().executionSteps[1].attemptStatus).toBe("committed");
    expect(
      projectExecutionTurns([], h.getState().executionSteps).latestTurn
        ?.sourceCommitted,
    ).toBe(true);
  });
  it.each([true, false])(
    "settles original turns as well as retries, committed=%s",
    (committed) => {
      const h = harness(false);
      h.send("runtime.started", {});
      h.send("runtime.completed", {
        status: "failed",
        error: "Narration failed",
      });
      h.send("execution.completed", { committed });
      expect(h.getState().executionSteps[1]).toMatchObject({
        turnId: "attempt",
        attemptStatus: committed ? "committed" : "failed",
      });
      expect(h.getState().executionSteps[1].sourceTurnId).toBeUndefined();
      expect(
        projectExecutionTurns([], h.getState().executionSteps).latestTurn
          ?.sourceCommitted,
      ).toBe(committed);
    },
  );
  it("shows the selected task during preparation before runtime.started", () => {
    const h = harness();
    h.send("execution.started", { runtimeCount: 1 });
    expect(h.getState().executionSteps[1]).toMatchObject({
      turnId: "attempt",
      sourceTurnId: "source",
      attemptStatus: "pending",
      status: "running",
    });
  });
  it.each([true, false])(
    "settles consecutive runtime/turn events atomically, committed=%s",
    (committed) => {
      const h = harness();
      h.send("runtime.started", {});
      h.send("runtime.completed", { status: "success" });
      expect(
        projectExecutionTurns([], h.getState().executionSteps).turns[0].steps[0]
          .status,
      ).toBe("running");
      h.send("execution.completed", { committed });
      expect(h.getState().executionSteps).toHaveLength(2);
      expect(h.getState().executionSteps[0]).toMatchObject({
        turnId: "source",
        status: "failed",
      });
      expect(h.getState().executionSteps[1]).toMatchObject({
        turnId: "attempt",
        sourceTurnId: "source",
        status: "completed",
        attemptStatus: committed ? "committed" : "failed",
      });
      expect(
        projectExecutionTurns([], h.getState().executionSteps).turns[0].steps[0]
          .status,
      ).toBe(committed ? "completed" : "failed");
    },
  );

  it("does not display a successful runtime as recovered after execution error", () => {
    const h = harness();
    h.send("runtime.started", {});
    h.send("runtime.completed", { status: "success" });
    h.send("error.occurred", { message: "Unable to save" });
    expect(h.getState().executionSteps[1].attemptStatus).toBe("failed");
    expect(
      projectExecutionTurns([], h.getState().executionSteps).turns[0].steps[0]
        .status,
    ).toBe("failed");
  });
});
