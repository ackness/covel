import { describe, it, expect } from "vitest";
import type * as api from "@/services/api.js";
import {
  aggregate,
  estimateCostUsd,
  estimateModelCost,
  UNKNOWN_MODEL,
} from "../-cost-panel.js";
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
    expect(m.totalCachedInput).toBe(0);
    expect(m.totalCacheWriteInput).toBe(0);
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

  it("attributes gateway usage when the executed target is recorded", () => {
    const model = aggregate([
      turn(1, "turn-1", [
        evt("gateway.responded", {
          runtimeId: "extractor",
          pluginId: "extractor",
          model: "gpt-5-mini",
          provider: "openai",
          ...usage(25, 5),
        }),
      ]),
    ]);

    expect(model.byModel).toEqual([
      expect.objectContaining({
        model: "gpt-5-mini",
        provider: "openai",
        inputTokens: 25,
        outputTokens: 5,
      }),
    ]);
  });

  it("returns an empty model when no usage events exist", () => {
    const m = aggregate([turn(1, "t", [evt("narrative.delta", {})])]);

    expect(m.totalCalls).toBe(0);
    expect(m.byRuntime).toHaveLength(0);
    expect(m.byTurn).toHaveLength(0);
    expect(m.byModel).toHaveLength(0);
  });

  it("attributes llm.responded usage to the preceding llm.calling model", () => {
    const turns = [
      turn(1, "turn-1", [
        evt("llm.calling", { runtimeId: "narrator", model: "deepseek-chat" }),
        evt("llm.responded", {
          runtimeId: "narrator",
          pluginId: "narrator",
          ...usage(100, 50),
        }),
        // Second tool-loop round on the same runtime, different model —
        // sequential pairing must pick the latest calling event.
        evt("llm.calling", { runtimeId: "narrator", model: "gpt-4o" }),
        evt("llm.responded", {
          runtimeId: "narrator",
          pluginId: "narrator",
          ...usage(30, 10),
        }),
      ]),
    ];

    const m = aggregate(turns);

    expect(m.byModel).toHaveLength(2);
    const deepseek = m.byModel.find((x) => x.model === "deepseek-chat")!;
    expect(deepseek.inputTokens).toBe(100);
    expect(deepseek.outputTokens).toBe(50);
    const gpt = m.byModel.find((x) => x.model === "gpt-4o")!;
    expect(gpt.inputTokens).toBe(30);
    expect(gpt.calls).toBe(1);
  });

  it("keeps the provider when the same model id is billed by different providers", () => {
    const turns = [
      turn(1, "turn-1", [
        evt("llm.calling", {
          runtimeId: "a",
          provider: "official",
          model: "shared-model",
        }),
        evt("llm.responded", { runtimeId: "a", ...usage(100, 50) }),
        evt("llm.calling", {
          runtimeId: "b",
          provider: "openai",
          model: "shared-model",
        }),
        evt("llm.responded", { runtimeId: "b", ...usage(200, 80) }),
      ]),
    ];

    const result = aggregate(turns);
    expect(result.byModel).toHaveLength(2);
    expect(result.byModel.map((model) => model.provider).sort()).toEqual([
      "official",
      "openai",
    ]);
  });

  it("applies a decimal provider multiplier to estimated settlement", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    };
    const price = { inputPerMToken: 2, outputPerMToken: 4 };

    expect(estimateCostUsd(usage, price, 0.1)).toBeCloseTo(0.4);
    expect(estimateCostUsd(usage, price, 2.5)).toBeCloseTo(10);
  });

  it("tracks missing input/output prices and cache tokens as unpriced", () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 10,
    };

    expect(estimateModelCost(usage, { inputPerMToken: 2 })).toMatchObject({
      pricedTokens: 60,
      unpricedTokens: 80,
    });
    expect(estimateModelCost(usage, { outputPerMToken: 4 })).toMatchObject({
      pricedTokens: 40,
      unpricedTokens: 100,
    });
    expect(
      estimateModelCost(usage, {
        inputPerMToken: 2,
        outputPerMToken: 4,
      }),
    ).toMatchObject({ pricedTokens: 100, unpricedTokens: 40 });
  });

  it("tracks cache usage and excludes unknown cache rates from cost", () => {
    const turns = [
      turn(1, "turn-1", [
        evt("llm.responded", {
          runtimeId: "world-ir",
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cachedInputTokens: 600_000,
            cacheWriteInputTokens: 100_000,
          },
        }),
      ]),
    ];

    const model = aggregate(turns);
    expect(model.totalInput).toBe(1_000_000);
    expect(model.totalCachedInput).toBe(600_000);
    expect(model.totalCacheWriteInput).toBe(100_000);
    expect(model.byRuntime[0]).toMatchObject({
      cachedInputTokens: 600_000,
      cacheWriteInputTokens: 100_000,
    });
    expect(
      estimateCostUsd(model.byModel[0]!, {
        inputPerMToken: 2,
        outputPerMToken: 4,
      }),
    ).toBeCloseTo(1);
  });

  it("sanitizes malformed trace counters and clamps cache subsets", () => {
    const model = aggregate([
      turn(1, "turn-1", [
        evt("llm.responded", {
          runtimeId: "bad",
          usage: {
            inputTokens: 10,
            outputTokens: -1,
            cachedInputTokens: 8,
            cacheWriteInputTokens: 9,
          },
        }),
      ]),
    ]);

    expect(model.totalOutput).toBe(0);
    expect(model.totalCachedInput).toBe(8);
    expect(model.totalCacheWriteInput).toBe(2);
    expect(
      estimateCostUsd(
        {
          inputTokens: 10,
          outputTokens: -1,
          cachedInputTokens: 8,
          cacheWriteInputTokens: 9,
        },
        { inputPerMToken: 1_000_000, outputPerMToken: 1_000_000 },
      ),
    ).toBe(0);
  });

  it("groups unattributable usage under the unknown-model bucket", () => {
    const turns = [
      turn(1, "turn-1", [
        // gateway.responded carries no model id.
        evt("gateway.responded", {
          runtimeId: "img",
          pluginId: "img",
          ...usage(5, 1),
        }),
        // llm.responded with no prior llm.calling for that runtime.
        evt("llm.responded", {
          runtimeId: "orphan",
          pluginId: "orphan",
          ...usage(7, 2),
        }),
      ]),
    ];

    const m = aggregate(turns);

    expect(m.byModel).toHaveLength(1);
    expect(m.byModel[0]!.model).toBe(UNKNOWN_MODEL);
    expect(m.byModel[0]!.inputTokens).toBe(12);
    expect(m.byModel[0]!.calls).toBe(2);
  });

  it("does not leak model pairing across turns", () => {
    const turns = [
      turn(1, "turn-1", [
        evt("llm.calling", { runtimeId: "narrator", model: "deepseek-chat" }),
        evt("llm.responded", {
          runtimeId: "narrator",
          pluginId: "narrator",
          ...usage(10, 5),
        }),
      ]),
      turn(2, "turn-2", [
        // No llm.calling this turn — must NOT inherit turn-1's model.
        evt("llm.responded", {
          runtimeId: "narrator",
          pluginId: "narrator",
          ...usage(20, 8),
        }),
      ]),
    ];

    const m = aggregate(turns);

    const deepseek = m.byModel.find((x) => x.model === "deepseek-chat")!;
    expect(deepseek.inputTokens).toBe(10);
    const unknown = m.byModel.find((x) => x.model === UNKNOWN_MODEL)!;
    expect(unknown.inputTokens).toBe(20);
  });
});
