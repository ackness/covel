import { describe, expect, it } from "vitest";

import { resolveReasoningEffortProfile } from "../src/index.js";

describe("reasoning effort profiles", () => {
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
        { value: "low" },
        { value: "medium" },
        { value: "high" },
        { value: "max" },
      ],
    });
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

  it("uses an automatic thinking mode for Qwen-compatible models", () => {
    expect(
      resolveReasoningEffortProfile(
        "qwen/qwen3.6-flash",
        "openai",
        "openai-chat-v1",
        ["reasoning"],
      ),
    ).toMatchObject({
      family: "qwen",
      options: [{ value: "disabled" }, { value: "automatic" }],
    });
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
