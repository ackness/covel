import { describe, expect, it } from "vitest";

import {
  extractReasoningRequestFields,
  resolveReasoningEffortProfile,
} from "../src/index.js";

describe("reasoning effort profiles", () => {
  it("recognizes deepseek-flash without a model-database entry", () => {
    expect(
      resolveReasoningEffortProfile("deepseek-flash", "deepseek"),
    ).toMatchObject({ family: "deepseek", defaultValue: "high" });
  });

  it("uses the namespaced model family before the transport provider", () => {
    expect(
      resolveReasoningEffortProfile(
        "deepseek/deepseek-v4-flash",
        "openai",
        "openai-chat-v1",
        ["reasoning"],
      ),
    ).toMatchObject({
      family: "deepseek",
      defaultValue: "high",
      options: [{ value: "disabled" }, { value: "high" }, { value: "max" }],
    });
  });

  it("exposes Anthropic effort levels supported by Claude 4.6", () => {
    expect(
      resolveReasoningEffortProfile(
        "claude-sonnet-4-6",
        "anthropic",
        "anthropic-messages-v1",
        ["reasoning"],
      ),
    ).toMatchObject({
      family: "anthropic",
      defaultValue: "high",
      options: [
        { value: "disabled" },
        { value: "low" },
        { value: "medium" },
        { value: "high" },
        { value: "max" },
      ],
    });
  });

  it("does not infer Anthropic effort support from extended thinking", () => {
    expect(
      resolveReasoningEffortProfile(
        "claude-sonnet-4-0",
        "anthropic",
        "anthropic-messages-v1",
        ["reasoning"],
      ),
    ).toBeNull();
  });

  it("keeps newer OpenAI and Gemini classifications provider-specific", () => {
    expect(
      resolveReasoningEffortProfile(
        "openai/gpt-5.6-sol",
        "openai",
        "openai-responses-v1",
        ["reasoning"],
      )?.options.map((option) => option.value),
    ).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);

    expect(
      resolveReasoningEffortProfile(
        "google/gemini-3.5-flash",
        "openai",
        "openai-chat-v1",
        ["reasoning"],
      )?.options.map((option) => option.value),
    ).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("offers explicit budget presets for confirmed Qwen models", () => {
    expect(
      resolveReasoningEffortProfile(
        "qwen/qwen3.6-flash",
        "openai",
        "openai-chat-v1",
        ["reasoning"],
      ),
    ).toMatchObject({
      family: "qwen",
      options: [
        { value: "disabled" },
        { value: "automatic" },
        { value: "low", thinkingBudgetTokens: 2048 },
        { value: "medium", thinkingBudgetTokens: 8192 },
        { value: "high", thinkingBudgetTokens: 16384 },
      ],
    });
  });

  it("keeps thinking-only Qwen models enabled", () => {
    expect(
      resolveReasoningEffortProfile(
        "qwen/qwen3-235b-a22b-thinking-2507",
        "dashscope",
        "openai-chat-v1",
        ["reasoning"],
      ),
    ).toMatchObject({
      family: "qwen",
      defaultValue: "automatic",
      options: [{ value: "automatic" }],
    });

    expect(
      extractReasoningRequestFields(
        { parameterOverrides: { reasoningEffort: "disabled" } },
        {
          profile: { provider: "dashscope" } as never,
          preset: {
            provider: "dashscope",
            model: "qwen/qwen3-235b-a22b-thinking-2507",
          } as never,
          mode: "text",
        },
        "openai-chat-v1",
        "qwen/qwen3-235b-a22b-thinking-2507",
      ),
    ).toEqual({ enable_thinking: true });
  });

  it("only exposes high effort for gpt-5-pro", () => {
    expect(
      resolveReasoningEffortProfile(
        "openai/gpt-5-pro",
        "openai",
        "openai-responses-v1",
        ["reasoning"],
      ),
    ).toMatchObject({
      family: "openai",
      defaultValue: "high",
      options: [{ value: "high" }],
    });
  });

  it("drops stale effort overrides unsupported by the selected model", () => {
    expect(
      extractReasoningRequestFields(
        { parameterOverrides: { reasoningEffort: "low" } },
        {
          profile: { provider: "anthropic" } as never,
          preset: {
            provider: "anthropic",
            model: "claude-sonnet-4-0",
          } as never,
          mode: "text",
        },
        "anthropic-messages-v1",
        "claude-sonnet-4-0",
      ),
    ).toEqual({});

    expect(
      extractReasoningRequestFields(
        { parameterOverrides: { reasoningEffort: "medium" } },
        {
          profile: { provider: "openai" } as never,
          preset: { provider: "openai", model: "gpt-5-pro" } as never,
          mode: "text",
        },
        "openai-responses-v1",
        "gpt-5-pro",
      ),
    ).toEqual({});
  });

  it("does not expose effort controls on recognised non-reasoning models", () => {
    expect(
      resolveReasoningEffortProfile(
        "openai/gpt-4o",
        "openai",
        "openai-chat-v1",
        ["vision"],
      ),
    ).toBeNull();
    expect(
      resolveReasoningEffortProfile(
        "claude-3-5-sonnet",
        "anthropic",
        "anthropic-messages-v1",
        ["function_calling"],
      ),
    ).toBeNull();
  });
});

describe("Qwen native effort and budget presets", () => {
  it.each([
    [
      "qwen3.8-flash",
      "low",
      { enable_thinking: true, reasoning_effort: "low" },
    ],
    [
      "qwen3.8-flash",
      "xhigh",
      { enable_thinking: true, reasoning_effort: "xhigh" },
    ],
    [
      "qwen3.8-flash",
      "disabled",
      { enable_thinking: false, reasoning_effort: "none" },
    ],
    [
      "qwen3.6-flash",
      "medium",
      { enable_thinking: true, thinking_budget: 8192 },
    ],
    ["qwen3.7-plus", "high", { enable_thinking: true, thinking_budget: 16384 }],
  ])(
    "maps %s / %s to the native wire control",
    (model, reasoningEffort, fields) => {
      expect(
        extractReasoningRequestFields(
          { parameterOverrides: { reasoningEffort } },
          undefined,
          "openai-chat-v1",
          model,
        ),
      ).toEqual(fields);
    },
  );

  it("does not invent budget support on other Qwen protocols", () => {
    const profile = resolveReasoningEffortProfile(
      "qwen3.6-flash",
      "dashscope",
      "openai-responses-v1",
    );
    expect(
      profile?.options.some(
        (option) => option.thinkingBudgetTokens !== undefined,
      ),
    ).toBe(false);
  });
});
