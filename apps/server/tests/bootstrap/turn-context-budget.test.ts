import { describe, it, expect, vi } from "vitest";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { createMemoryStore, type TurnMessageRecord } from "@covel/store";
import {
  createBootstrapCompactorRunner,
  createTurnContextBudget,
} from "../../src/routes/api/bootstrap/compactor.js";

describe("createTurnContextBudget", () => {
  it("prefers the explicit env override over capability", () => {
    const budget = createTurnContextBudget({
      contextWindowOverride: 8000,
      resolveNarrativeBudget: () => ({
        contextWindow: 128_000,
        maxOutputTokens: 1024,
      }),
    });

    expect(budget.maxInputTokens).toBe(8000);
    // reservedForResponse still comes from capability — the override only
    // pins the window.
    expect(budget.reservedForResponse).toBe(1024);
  });

  it("derives window and reserve from the narrative slot capability", () => {
    const budget = createTurnContextBudget({
      resolveNarrativeBudget: () => ({
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
      }),
    });

    expect(budget.maxInputTokens).toBe(200_000);
    expect(budget.reservedForResponse).toBe(16_000);
  });

  it("falls back to 32768 / 4000 when no source is available", () => {
    const budget = createTurnContextBudget({});

    expect(budget.maxInputTokens).toBe(32_768);
    expect(budget.reservedForResponse).toBe(4000);
  });

  it("re-resolves capability on every access (llm.toml hot-reload)", () => {
    let window = 64_000;
    const budget = createTurnContextBudget({
      resolveNarrativeBudget: () => ({ contextWindow: window }),
    });

    expect(budget.maxInputTokens).toBe(64_000);
    window = 1_000_000;
    expect(budget.maxInputTokens).toBe(1_000_000);
  });

  it.each([
    ["non-positive window", { contextWindow: 0, maxOutputTokens: 1 }],
    [
      "reserve equal to window",
      { contextWindow: 8_000, maxOutputTokens: 8_000 },
    ],
    [
      "reserve larger than window",
      { contextWindow: 8_000, maxOutputTokens: 8_001 },
    ],
  ])(
    "rejects %s instead of silently producing an unusable budget",
    (_label, values) => {
      const budget = createTurnContextBudget({
        resolveNarrativeBudget: () => values,
      });

      expect(() => budget.maxInputTokens).toThrow(RangeError);
      expect(() => budget.reservedForResponse).toThrow(RangeError);
    },
  );
});

describe("createBootstrapCompactorRunner", () => {
  it("triggers against input capacity after reserving the configured response budget", async () => {
    const store = createMemoryStore();
    const generate = vi.fn(async (): Promise<LLMResponse> => ({
      content: "bounded summary",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const llmAdapter: LLMAdapter = { generate };
    const messages: TurnMessageRecord[] = Array.from(
      { length: 10 },
      (_, index) => ({
        id: `message-${index}`,
        sessionId: "session-1",
        turnId: `turn-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(200),
        createdAt: new Date(index).toISOString(),
      }),
    );

    const runner = createBootstrapCompactorRunner({
      manifestCache: new Map(),
      store,
      llmAdapter,
      resolveNarrativeBudget: () => ({
        contextWindow: 1_000,
        maxOutputTokens: 400,
      }),
    });

    const result = await runner.run("session-1", "", messages, "en-US");

    expect(result.compacted).toBe(true);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "fast", maxOutputTokens: 400 }),
    );
  });
});
