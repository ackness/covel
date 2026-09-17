import { describe, expect, it } from "vitest";
import { applyPerCallBudget } from "../src/agent-loop/request-context-budget.js";
import type { LLMAdapter } from "../src/llm/llm-adapter.js";

describe("pre-request budget errors", () => {
  it.each(["input", "output"])(
    "identifies the selected target when %s exceeds its window",
    (kind) => {
      const llm: LLMAdapter = {
        generate: async () => {
          throw new Error("must not call provider");
        },
        resolveTarget: () => ({
          provider: "custom-provider",
          model: "custom-model",
        }),
        resolveBudget: () => ({
          contextWindow: 100,
          requestedMaxOutputTokens: kind === "output" ? 100 : 40,
        }),
      };
      expect(() =>
        applyPerCallBudget({
          runtimeId: "test-runtime",
          llm,
          slot: "custom-slot",
          messages: [{ role: "user", content: "x".repeat(200) }],
          tools: undefined,
          responseFormat: undefined,
          retryPolicy: { maxRetries: 0 },
          estimator: (value) => value.length,
          contextBudget: { maxInputTokens: 100, reservedForResponse: 40 },
        }),
      ).toThrow(
        /provider: custom-provider, model: custom-model, slot: custom-slot/,
      );
    },
  );
});
