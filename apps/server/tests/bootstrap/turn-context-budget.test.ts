import { describe, it, expect, vi } from "vitest";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { createMemoryStore, type TurnMessageRecord } from "@covel/store";
import {
  createBootstrapCompactorRunner,
  createTurnContextBudget,
} from "../../src/routes/api/bootstrap/compactor.js";

describe("createTurnContextBudget", () => {
  it("retains the explicit deployment ceiling", () => {
    const budget = createTurnContextBudget({ contextWindowOverride: 8000 });
    expect(budget.maxInputTokens).toBe(8000);
    expect(budget.reservedForResponse).toBe(4000);
    expect(budget.contextWindowLimit).toBe(8000);
  });

  it("falls back to 32768 / 16384 without imposing a model ceiling", () => {
    const budget = createTurnContextBudget({});
    expect(budget.maxInputTokens).toBe(32_768);
    expect(budget.reservedForResponse).toBe(16_384);
    expect(budget.contextWindowLimit).toBeUndefined();
  });

  it("rejects an invalid deployment window", () => {
    expect(() => createTurnContextBudget({ contextWindowOverride: 0 })).toThrow(
      RangeError,
    );
  });
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
    const resolveBudget = vi.fn(() => ({
      contextWindow: 1000,
      maxOutputTokens: 400,
    }));
    const llmAdapter: LLMAdapter = { generate, resolveBudget };
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
    });

    const result = await runner.run("session-1", "", messages, "en-US");

    expect(result.compacted).toBe(true);
    expect(resolveBudget).toHaveBeenCalledWith("fast");
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "fast", maxOutputTokens: 400 }),
    );
  });
});
