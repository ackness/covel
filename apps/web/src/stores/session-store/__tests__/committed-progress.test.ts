import { describe, expect, it } from "vitest";
import type { SseEnvelope } from "@/services/api.js";
import { initialState, reducer } from "../reducer.js";
import { createSseEventHandler } from "../sse-handler.js";
import { createSubscriptionEventHandler } from "../subscription.js";
import type { SessionState } from "../types.js";

function harness() {
  const stateRef: { current: SessionState } = {
    current: {
      ...initialState,
      executing: true,
      messages: [
        {
          id: "previous",
          role: "assistant",
          kind: "story",
          content: "Previous full story",
          timestamp: "before",
          turnId: "old",
        },
      ],
    },
  };
  const deps = {
    stateRef,
    sessionIdRef: { current: "s" },
    dispatch: (action: Parameters<typeof reducer>[1]) => {
      stateRef.current = reducer(stateRef.current, action);
    },
  };
  const handle = createSseEventHandler({
    ...deps,
    lastBackfilledTurnIdRef: { current: null },
  });
  const observe = createSubscriptionEventHandler({
    ...deps,
    isCurrent: () => true,
    onReset: () => {},
    onBackgroundJobEnded: () => {},
    getRecoveryGeneration: () => 0,
  });
  const event = (
    type: string,
    extra: Record<string, unknown> = {},
  ): SseEnvelope => ({
    type,
    sessionId: "s",
    turnId: "turn",
    requestId: "r",
    flowId: "f",
    traceId: "trace",
    seq: 1,
    timestamp: "now",
    payload: {
      turnId: "turn",
      runtimeId: "p/story",
      pluginId: "p",
      runId: "outer",
      ...extra,
    },
  });
  return { stateRef, handle, observe, event };
}

describe("committed story progress", () => {
  it("shows safe revision across the next attempt without storing candidate or review text", () => {
    const h = harness();
    h.handle(h.event("runtime.started"));
    h.handle(
      h.event("step.completed", {
        step: 1,
        output: "PRIVATE CANDIDATE",
        notes: [
          {
            kind: "output-rejected",
            reason: "review-rejected",
            attempt: 1,
            feedback: "PRIVATE REVIEW",
          },
        ],
      }),
    );
    expect(h.stateRef.current.executionSteps[0]).toMatchObject({
      runId: "outer",
      status: "running",
      revising: true,
    });
    h.handle(h.event("step.started", { step: 2 }));
    h.handle(h.event("llm.calling", { messages: ["PRIVATE CANDIDATE"] }));
    expect(h.stateRef.current.executionSteps[0]?.revising).toBe(true);
    h.handle(h.event("step.completed", { step: 1, notes: [] }));
    expect(h.stateRef.current.executionSteps[0]?.modelStep).toBe(2);
    expect(h.stateRef.current.executionSteps[0]?.revising).toBe(true);
    h.handle(
      h.event("tool.calling", {
        toolName: "submit-output",
        arguments: "PRIVATE CANDIDATE",
      }),
    );
    expect(h.stateRef.current.executionSteps[0]?.status).toBe("tool");
    expect(h.stateRef.current.messages.map((m) => m.id)).toEqual(["previous"]);
    expect(JSON.stringify(h.stateRef.current)).not.toContain("PRIVATE");
  });
  it("keeps revision when a whole event batch arrives before React publishes its mirror", () => {
    const h = harness();
    const original = h.stateRef.current;
    const queued: Parameters<typeof reducer>[1][] = [];
    const handle = createSseEventHandler({
      stateRef: { current: original },
      sessionIdRef: { current: "s" },
      lastBackfilledTurnIdRef: { current: null },
      dispatch: (a) => queued.push(a),
    });
    handle(h.event("runtime.started"));
    handle(
      h.event("step.completed", {
        step: 1,
        notes: [
          { kind: "output-rejected", reason: "invalid-output", attempt: 1 },
        ],
      }),
    );
    handle(h.event("step.started", { step: 2 }));
    handle(h.event("llm.calling", { messages: ["PRIVATE"] }));
    const state = queued.reduce(reducer, original);
    expect(state.executionSteps).toHaveLength(1);
    expect(state.executionSteps[0]).toMatchObject({
      runId: "outer",
      modelStep: 2,
      status: "llm",
      revising: true,
    });
    expect(state.messages).toEqual(original.messages);
    expect(JSON.stringify(queued)).not.toContain("PRIVATE");
  });

  it("does not turn arbitrary note text into revision state", () => {
    const h = harness();
    h.handle(h.event("runtime.started"));
    h.handle(
      h.event("step.completed", {
        notes: [
          { kind: "output-rejected", reason: "PRIVATE REVIEW", attempt: 1 },
        ],
      }),
    );
    expect(h.stateRef.current.executionSteps[0]?.revising).toBe(false);
    expect(JSON.stringify(h.stateRef.current)).not.toContain("PRIVATE");
  });
  it("keeps nested runs distinct and ignores late progress or admission after termination", () => {
    const h = harness();
    h.handle(h.event("runtime.started"));
    h.handle(h.event("runtime.started", { runId: "child" }));
    h.handle(h.event("tool.calling", { runId: "child", toolName: "read" }));
    h.handle(
      h.event("runtime.completed", {
        runId: "child",
        status: "success",
        output: "PRIVATE CANDIDATE",
      }),
    );
    h.handle(
      h.event("step.completed", {
        runId: "child",
        notes: [
          { kind: "output-rejected", reason: "invalid-output", attempt: 1 },
        ],
      }),
    );
    h.handle(h.event("runtime.started", { runId: "child" }));
    expect(
      h.stateRef.current.executionSteps.map((s) => [s.runId, s.status]),
    ).toEqual([
      ["outer", "running"],
      ["child", "completed"],
    ]);
    expect(h.stateRef.current.messages).toHaveLength(1);
  });
  it("deduplicates action, observer and reload delivery while retaining resolved speakers", () => {
    const h = harness();
    const complete = h.event("narrative.completed", {
      kind: "story",
      messageId: "durable",
      content: "Hello.",
      segments: [
        {
          kind: "dialogue",
          text: "Hello.",
          speaker: "Resolved",
          speakerId: "character",
        },
      ],
    });
    h.handle(complete);
    h.observe({
      id: "observer",
      topic: "state",
      type: complete.type,
      sessionId: "s",
      timestamp: "now",
      payload: { ...complete.payload, segments: undefined },
    });
    h.stateRef.current = reducer(h.stateRef.current, {
      type: "MERGE_RECOVERED_MESSAGES",
      messages: [...h.stateRef.current.messages],
    });
    expect(h.stateRef.current.messages.map((m) => m.id)).toEqual([
      "previous",
      "durable",
    ]);
    expect(h.stateRef.current.messages[1]?.segments?.[0]).toMatchObject({
      speaker: "Resolved",
      speakerId: "character",
    });
    h.handle(
      h.event("narrative.completed", {
        kind: "story",
        content: "Malformed delivery",
      }),
    );
    expect(h.stateRef.current.messages).toHaveLength(2);
  });
});
