import { describe, expect, it } from "vitest";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../sse-handler.js";
import { initialState, reducer } from "../reducer.js";
import { reconcileExecutionSteps } from "../snapshot-execution-steps.js";
import type { SessionState } from "../types.js";

const timestamp = "2026-09-18T00:00:00Z";
const payload = {
  runtimeId: "story/main",
  pluginId: "story",
  flowId: "flow",
  seq: 1,
  reasoningContent: "summary",
};

describe("reasoning live and recovery", () => {
  it("retains consecutive calls with batched React updates and deduplicates trace replay", () => {
    let state: SessionState = {
      ...initialState,
      executionSteps: [
        {
          runtimeId: payload.runtimeId,
          pluginId: "story",
          turnId: "turn",
          status: "completed",
        },
      ],
    };
    const initial = state;
    const handler = createSseEventHandler({
      dispatch: (action) => {
        state = reducer(state, action);
      },
      ds: {} as SseEventHandlerDeps["ds"],
      sessionIdRef: { current: "session" },
      stateRef: { current: state },
      runtimeKindRef: { current: new Map() },
      deltaBufferRef: { current: new Map() },
      deltaRafRef: { current: null },
      lastBackfilledTurnIdRef: { current: "turn" },
    });
    const event = {
      requestId: "request",
      traceId: "trace",
      flowId: "flow",
      seq: 1,
      type: "llm.responded",
      sessionId: "session",
      turnId: "turn",
      timestamp,
      payload,
    };
    handler(event);
    handler({
      ...event,
      payload: { ...payload, seq: 2, reasoningContent: "second" },
    });
    handler(event);
    handler({ ...event, sessionId: "other", payload: { ...payload, seq: 3 } });
    expect(
      state.executionSteps[0]?.reasoning?.map((entry) => entry.content),
    ).toEqual(["summary", "second"]);
    state = reducer(state, {
      type: "UPSERT_EXECUTION_STEP",
      step: initial.executionSteps[0]!,
    });
    expect(state.executionSteps[0]?.reasoning).toHaveLength(2);
    const recovered = reconcileExecutionSteps(state.executionSteps, [event]);
    expect(recovered[0]?.status).toBe("completed");
    expect(recovered[0]?.reasoning).toEqual(state.executionSteps[0]?.reasoning);
  });

  it("recovers plugin calls without exposing opaque-only output", () => {
    const steps = reconcileExecutionSteps(
      [],
      [
        { type: "gateway.responded", turnId: "turn", timestamp, payload },
        {
          type: "gateway.responded",
          turnId: "turn",
          timestamp,
          payload: {
            ...payload,
            seq: 2,
            reasoningContent: "  ",
            signature: "opaque",
          },
        },
        {
          type: "runtime.completed",
          turnId: "turn",
          timestamp,
          payload: { ...payload, status: "success" },
        },
      ],
    );
    expect(steps[0]?.status).toBe("completed");
    expect(steps[0]?.reasoning).toHaveLength(1);
    expect(steps[0]?.reasoning?.[0]?.content).toBe("summary");
  });
});
