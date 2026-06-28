import { describe, it, expect } from "vitest";
import type * as api from "@/services/api.js";
import { aggregate } from "../-cost-panel.js";
import type { VisibleTurn } from "../-debug-page-model.js";

function evt(type: string, payload: Record<string, unknown>): api.TraceEvent {
  return {
    type,
    payload,
    seq: 0,
    timestamp: "",
    traceId: "",
    sessionId: "s",
    turnId: "t",
    flowId: "",
    requestId: "",
  } as api.TraceEvent;
}

function turn(
  turnIndex: number,
  turnId: string,
  events: api.TraceEvent[],
): VisibleTurn {
  return { turn: { turnId, events } as unknown as api.TurnTrace, turnIndex };
}

const usage = (i: number, o: number) => ({
  usage: { inputTokens: i, outputTokens: o },
});

describe("cost-panel aggregate", () => {
  it("sums tokens per runtime, per turn, and session total from llm.responded", () => {
    const turns = [
      turn(1, "turn-1", [
        evt("llm.responded", {
          runtimeId: "narrator",
          pluginId: "narrator",
          ...usage(100, 50),
        }),
        evt("llm.responded", {
          runtimeId: "guide",
          pluginId: "guide",
          ...usage(20, 10),
        }),
        evt("narrative.delta", { text: "x" }), // not a usage event — ignored
      ]),
      turn(2, "turn-2", [
        evt("llm.responded", {
          runtimeId: "narrator",
          pluginId: "narrator",
          ...usage(200, 80),
        }),
      ]),
    ];

    const m = aggregate(turns);

    expect(m.totalInput).toBe(320);
    expect(m.totalOutput).toBe(140);
    expect(m.totalCalls).toBe(3);
    // byRuntime sorted by total tokens desc — narrator (430) before guide (30).
    expect(m.byRuntime[0]!.runtimeId).toBe("narrator");
    expect(m.byRuntime[0]!.inputTokens).toBe(300);
    expect(m.byRuntime[0]!.outputTokens).toBe(130);
    expect(m.byRuntime[0]!.calls).toBe(2);
    expect(m.byRuntime[1]!.runtimeId).toBe("guide");
    // byTurn keeps the story turn index and per-turn sums.
    expect(m.byTurn).toHaveLength(2);
    expect(m.byTurn[0]!.turnIndex).toBe(1);
    expect(m.byTurn[0]!.inputTokens).toBe(120);
    expect(m.byTurn[1]!.inputTokens).toBe(200);
  });

  it("counts gateway.responded usage and skips events without usage", () => {
    const turns = [
      turn(1, "turn-1", [
        evt("gateway.responded", {
          runtimeId: "img",
          pluginId: "img",
          ...usage(5, 0),
        }),
        evt("llm.responded", { runtimeId: "x", pluginId: "x" }), // no usage field
        evt("tool.completed", { runtimeId: "x" }), // not a usage event
      ]),
    ];

    const m = aggregate(turns);

    expect(m.totalCalls).toBe(1);
    expect(m.totalInput).toBe(5);
    expect(m.byRuntime).toHaveLength(1);
    expect(m.byRuntime[0]!.runtimeId).toBe("img");
  });

  it("returns an empty model when no usage events exist", () => {
    const m = aggregate([turn(1, "t", [evt("narrative.delta", {})])]);

    expect(m.totalCalls).toBe(0);
    expect(m.byRuntime).toHaveLength(0);
    expect(m.byTurn).toHaveLength(0);
  });
});
