import { describe, expect, it } from "vitest";
import type * as api from "@/services/api.js";
import { validateDebugSearch } from "../../debug.js";
import {
  getStoryTurnCount,
  getVisibleTurns,
  traceEventMatchesCategory,
} from "../-debug-page-model.js";

function traceEvent(
  type: string,
  payload: Record<string, unknown> = {},
): api.TraceEvent {
  return {
    type,
    requestId: "req",
    traceId: "trace",
    sessionId: "session",
    turnId: "turn",
    flowId: "flow",
    seq: 1,
    timestamp: "2026-05-11T00:00:00.000Z",
    payload,
  };
}

function turn(turnId: string, events: api.TraceEvent[]): api.TurnTrace {
  return {
    turnId,
    flowId: `flow-${turnId}`,
    traceId: `trace-${turnId}`,
    startedAt: "2026-05-11T00:00:00.000Z",
    completedAt: "2026-05-11T00:00:01.000Z",
    eventCount: events.length,
    events: events.map((event, index) => ({
      ...event,
      turnId,
      seq: index + 1,
    })),
  };
}

describe("debug route model", () => {
  it("keeps route search params limited to a string sid", () => {
    expect(validateDebugSearch({ sid: "session-1" })).toEqual({
      sid: "session-1",
    });
    expect(validateDebugSearch({ sid: 42 })).toEqual({ sid: undefined });
  });

  it("counts story turns while retaining manual invocation placement", () => {
    const storyA = turn("story-a", [traceEvent("turn.started")]);
    const manual = turn("manual", [
      traceEvent("turn.started", {
        manualTrigger: { runtimeId: "plugin/manual" },
      }),
    ]);
    const storyB = turn("story-b", [traceEvent("turn.started")]);

    expect(getStoryTurnCount([storyA, manual, storyB])).toBe(2);
    expect(
      getVisibleTurns([storyA, manual, storyB]).map((item) => item.turnIndex),
    ).toEqual([1, 1, 2]);
  });

  it("matches both outer trace event types and runtime progress inner types", () => {
    expect(
      traceEventMatchesCategory(traceEvent("state.patch.applied"), "state"),
    ).toBe(true);
    expect(
      traceEventMatchesCategory(
        traceEvent("runtime.progress", { type: "tool.calling" }),
        "tool",
      ),
    ).toBe(true);
    expect(
      traceEventMatchesCategory(traceEvent("message.completed"), "llm"),
    ).toBe(false);
  });
});
