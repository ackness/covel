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

describe("response schema budget", () => {
  // The schema reaches the provider in the system prompt and, on the
  // Responses and Gemini wires, again as a native field.
  it("reserves room for both copies of the schema", () => {
    const responseFormat = {
      type: "json_schema" as const,
      schema: { type: "object", description: "d".repeat(300) },
    };
    const copy =
      `<response_format>${JSON.stringify(responseFormat)}</response_format>`
        .length;
    const budget = (inputLimit: number) =>
      applyPerCallBudget({
        runtimeId: "test-runtime",
        llm: {
          generate: async () => {
            throw new Error("must not call provider");
          },
          resolveBudget: () => ({
            contextWindow: inputLimit + 40,
            requestedMaxOutputTokens: 40,
          }),
        },
        slot: undefined,
        messages: [{ role: "user", content: "go" }],
        tools: undefined,
        responseFormat,
        retryPolicy: { maxRetries: 0 },
        estimator: (value) => value.length,
        contextBudget: {
          maxInputTokens: inputLimit + 40,
          reservedForResponse: 40,
        },
      });

    expect(() => budget(copy + 50)).toThrow(/Context budget exceeded/);
    expect(() => budget(2 * copy + 50)).not.toThrow();
  });
});

describe("markers of a cut request", () => {
  const llm: LLMAdapter = {
    generate: async () => {
      throw new Error("must not call provider");
    },
  };
  const toolResult = (locale?: string) =>
    String(
      applyPerCallBudget({
        runtimeId: "test-runtime",
        llm,
        slot: undefined,
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-1", name: "read", arguments: "{}" }],
          },
          { role: "tool", toolCallId: "call-1", content: "x".repeat(2_000) },
        ],
        tools: undefined,
        responseFormat: undefined,
        retryPolicy: { maxRetries: 0 },
        estimator: (value) => value.length,
        contextBudget: { maxInputTokens: 1_000, reservedForResponse: 100 },
        ...(locale ? { locale } : {}),
      }).messages.find((message) => message.role === "tool")!.content,
    );

  it("marks a cut tool result in the instruction language of the session", () => {
    expect(toolResult("zh-CN")).toContain(
      "[工具结果已截断；需要时查询更小的范围]",
    );
    expect(toolResult("zh-CN")).not.toContain("tool result truncated");
    for (const locale of ["en-US", "zh-Hant-TW", undefined])
      expect(toolResult(locale)).toContain(
        "[tool result truncated; query a narrower scope if needed]",
      );
  });
});
