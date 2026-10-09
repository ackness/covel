import { describe, expect, it } from "vitest";

import { extractReasoningRequestFields } from "../src/protocol-registry.js";
import { resolveReasoningEffortProfile } from "../src/reasoning-effort.js";

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

  it("gives GPT-6 its levels without a model-database entry", () => {
    // A model behind a proxy, under a provider name of the user's choice.
    expect(
      resolveReasoningEffortProfile(
        "codex/gpt-6-luna",
        "local",
        "openai-chat-v1",
      )?.options.map((option) => option.value),
    ).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    const sent = (reasoningEffort: string) =>
      extractReasoningRequestFields(
        { reasoningEffort },
        {
          profile: { provider: "local" } as never,
          preset: { provider: "local", model: "codex/gpt-6-luna" } as never,
          mode: "text",
        },
        "openai-chat-v1",
        "codex/gpt-6-luna",
      );
    expect(sent("low")).toEqual({ reasoning_effort: "low" });
    expect(sent("max")).toEqual({ reasoning_effort: "max" });
    // A bookkeeping runtime's default of no reasoning arrives here as `none`.
    expect(sent("none")).toEqual({ reasoning_effort: "none" });
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

describe("Gemini thinking controls", () => {
  it.each([
    ["gemini-3-pro-preview", ["low", "high"], "high"],
    ["gemini-3.1-pro-preview", ["low", "medium", "high"], "high"],
    ["gemini-3-flash-preview", ["minimal", "low", "medium", "high"], "high"],
    ["gemini-3.5-flash", ["minimal", "low", "medium", "high"], "medium"],
    ["gemini-3.6-flash", ["minimal", "low", "medium", "high"], "medium"],
    ["gemini-3.7-flash", ["low", "medium", "high"], "medium"],
    ["gemini-3.8-flash", ["low", "medium", "high"], "medium"],
    ["gemini-3.1-flash-lite", ["minimal", "low", "medium", "high"], "minimal"],
    ["gemini-3.5-flash-lite", ["minimal", "low", "medium", "high"], "minimal"],
  ] as const)(
    "offers only documented levels for %s",
    (model, levels, defaultValue) => {
      expect(
        resolveReasoningEffortProfile(
          `google/${model}`,
          "openai",
          "google-generative-ai-v1",
          ["reasoning"],
        ),
      ).toMatchObject({
        family: "google",
        defaultValue,
        options: levels.map((value) => ({ value })),
      });
    },
  );

  it("uses explicit application budget presets for Gemini 2.5", () => {
    expect(
      resolveReasoningEffortProfile("gemini-2.5-pro", "google")?.options,
    ).toEqual([
      { value: "low", thinkingBudgetTokens: 1024 },
      { value: "medium", thinkingBudgetTokens: 8192 },
      { value: "high", thinkingBudgetTokens: 24576 },
    ]);
    expect(
      resolveReasoningEffortProfile("gemini-2.5-flash-lite", "google")?.options,
    ).toEqual([
      { value: "none", thinkingBudgetTokens: 0 },
      { value: "low", thinkingBudgetTokens: 1024 },
      { value: "medium", thinkingBudgetTokens: 8192 },
      { value: "high", thinkingBudgetTokens: 24576 },
    ]);
  });

  it.each([
    [
      "gemini-3-pro-preview",
      "low",
      { thinkingConfig: { thinkingLevel: "low" } },
    ],
    [
      "gemini-3.1-pro-preview",
      "medium",
      { thinkingConfig: { thinkingLevel: "medium" } },
    ],
    ["gemini-3.8-flash", "high", { thinkingConfig: { thinkingLevel: "high" } }],
    ["gemini-2.5-pro", "low", { thinkingConfig: { thinkingBudget: 1024 } }],
    [
      "gemini-2.5-flash",
      "medium",
      { thinkingConfig: { thinkingBudget: 8192 } },
    ],
    [
      "gemini-2.5-flash-lite",
      "none",
      { thinkingConfig: { thinkingBudget: 0 } },
    ],
  ] as const)(
    "maps native %s / %s to generationConfig fields",
    (model, selection, fields) => {
      expect(
        extractReasoningRequestFields(
          { parameterOverrides: { reasoningEffort: selection } },
          undefined,
          "google-generative-ai-v1",
          model,
        ),
      ).toEqual(fields);
    },
  );

  it("keeps the OpenAI compatibility wire as reasoning_effort", () => {
    expect(
      extractReasoningRequestFields(
        { parameterOverrides: { reasoningEffort: "minimal" } },
        undefined,
        "openai-chat-v1",
        "gemini-2.5-flash",
      ),
    ).toEqual({ reasoning_effort: "minimal" });
    expect(
      extractReasoningRequestFields(
        { parameterOverrides: { reasoningEffort: "minimal" } },
        undefined,
        "openai-chat-v1",
        "gemini-3.1-pro-preview",
      ),
    ).toEqual({ reasoning_effort: "minimal" });
    expect(
      resolveReasoningEffortProfile(
        "gemini-3.1-pro-preview",
        "google",
        "openai-chat-v1",
      )?.options.map(({ value }) => value),
    ).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("drops unsupported or unknown Gemini selections", () => {
    for (const [model, selection] of [
      ["gemini-3-pro-preview", "medium"],
      ["gemini-3.8-flash", "minimal"],
      ["gemini-2.5-pro", "none"],
      ["gemini-2.5-flash", "minimal"],
      ["gemini-2.5-flash-image", "high"],
      ["gemini-3.1-flash-lite-image", "minimal"],
      ["gemini-4-pro", "high"],
    ]) {
      expect(
        extractReasoningRequestFields(
          { parameterOverrides: { reasoningEffort: selection } },
          undefined,
          "google-generative-ai-v1",
          model,
        ),
      ).toEqual({});
    }
    expect(
      resolveReasoningEffortProfile(
        "gemini-4-pro",
        "google",
        "google-generative-ai-v1",
        ["reasoning"],
      ),
    ).toBeNull();
  });
});
