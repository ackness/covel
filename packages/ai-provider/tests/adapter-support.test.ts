import { describe, expect, it } from "vitest";
import { projectCapabilityForBuiltinAdapter } from "../src/capability/adapter-support.js";
import { mergeRequestCapabilityOverride } from "../src/capability/resolver.js";
import type { ModelCapability, ProviderProtocol } from "../src/types.js";

const multimodal: ModelCapability = {
  input: ["text", "image", "audio", "video", "file"],
  output: ["text", "image", "audio"],
  features: [
    "function_calling",
    "vision",
    "reasoning",
    "web_search",
    "computer_use",
  ],
  contextWindow: 128_000,
  pricing: { inputPerMToken: 2 },
};

describe("built-in adapter capability projection", () => {
  it.each([
    "openai-chat-v1",
    "openai-responses-v1",
    "anthropic-messages-v1",
    "google-generative-ai-v1",
  ] as const)("limits %s text requests to implemented shapes", (protocol) => {
    const effective = projectCapabilityForBuiltinAdapter(
      multimodal,
      protocol,
      "text",
    );

    expect(effective).toEqual({
      ...multimodal,
      input: ["text", "image"],
      output: ["text"],
      features: ["function_calling", "vision", "reasoning"],
    });
    expect(multimodal.input).toEqual([
      "text",
      "image",
      "audio",
      "video",
      "file",
    ]);
    expect(multimodal.output).toEqual(["text", "image", "audio"]);
  });

  it("does not let a full request override resurrect unsupported text capabilities", () => {
    const override = mergeRequestCapabilityOverride(
      { input: ["text"], output: ["text"] },
      {
        input: ["text", "audio", "video", "file"],
        output: ["text", "audio"],
        features: ["web_search", "computer_use", "streaming"],
      },
      "full",
    );

    expect(
      projectCapabilityForBuiltinAdapter(
        override,
        "openai-responses-v1",
        "text",
      ),
    ).toMatchObject({
      input: ["text"],
      output: ["text"],
      features: ["streaming"],
    });
  });

  it.each(["image", "speech", "transcription", "embedding", "evaluation"])(
    "preserves separate %s wire capabilities",
    (role) => {
      expect(
        projectCapabilityForBuiltinAdapter(multimodal, "openai-chat-v1", role),
      ).toBe(multimodal);
    },
  );

  it("does not constrain a custom adapter without a built-in protocol", () => {
    expect(
      projectCapabilityForBuiltinAdapter(multimodal, undefined, "text"),
    ).toBe(multimodal);
  });

  it("never invents text output or vision support", () => {
    const imageOnly: ModelCapability = {
      input: ["audio"],
      output: ["image"],
      features: ["vision", "web_search"],
    };
    expect(
      projectCapabilityForBuiltinAdapter(
        imageOnly,
        "openai-chat-v1" satisfies ProviderProtocol,
        "text",
      ),
    ).toEqual({ input: [], output: [], features: [] });
  });
});
