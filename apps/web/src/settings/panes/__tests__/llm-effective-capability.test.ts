import { describe, expect, it } from "vitest";
import type {
  LlmSlotInfo,
  ModelCapabilityLookupResult,
} from "@/services/api.js";
import {
  resolveDisplayCapability,
  resolveEffectiveModelTarget,
} from "../llm-effective-capability.js";

const server: LlmSlotInfo = {
  provider: "deepseek",
  model: "deepseek-v4-flash",
  protocol: "openai-chat-v1",
  tag: "text",
  capability: {
    input: ["text"],
    output: ["text"],
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
  },
};
const fallback: ModelCapabilityLookupResult = {
  found: false,
  source: "protocol-default",
  pricingKind: "unknown",
  candidates: [],
  reasoning: null,
  capability: {
    input: ["text"],
    output: ["text"],
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
  },
};

describe("effective model capabilities", () => {
  it("uses the bound target and its protocol without inheriting the old slot limits", () => {
    const target = resolveEffectiveModelTarget(
      {
        provider: "ali-coding-plan",
        model: "qwen3.8-flash",
        protocol: "openai-chat-v1",
      },
      server,
    );
    expect(target).toEqual({
      provider: "ali-coding-plan",
      model: "qwen3.8-flash",
      protocol: "openai-chat-v1",
      baseCapability: undefined,
    });
    const displayed = resolveDisplayCapability(fallback, target.baseCapability);
    expect(displayed?.contextWindow).toBeUndefined();
    expect(displayed?.maxOutputTokens).toBeUndefined();
  });

  it("does not inherit another provider's protocol when the bound model omits one", () => {
    const target = resolveEffectiveModelTarget(
      { provider: "custom-connection", model: "opaque-id" },
      { ...server, protocol: "anthropic-v1" },
    );
    expect(target.protocol).toBe("openai-chat-v1");
  });

  it("keeps unknown model limits unknown while honoring explicit user limits", () => {
    expect(
      resolveDisplayCapability(fallback, server.capability)?.maxOutputTokens,
    ).toBeUndefined();
    expect(
      resolveDisplayCapability(fallback, server.capability, {
        maxOutputTokens: 12_000,
      })?.maxOutputTokens,
    ).toBe(12_000);
    expect(
      resolveDisplayCapability(null, server.capability)?.maxOutputTokens,
    ).toBeUndefined();
  });

  it("preserves configured limits for a known current server target", () => {
    const lookup: ModelCapabilityLookupResult = {
      ...fallback,
      found: true,
      source: "known",
    };
    const target = resolveEffectiveModelTarget(undefined, server);
    expect(
      resolveDisplayCapability(lookup, target.baseCapability)?.maxOutputTokens,
    ).toBe(384_000);
    expect(resolveDisplayCapability(lookup, undefined)?.maxOutputTokens).toBe(
      4_096,
    );
  });
});
