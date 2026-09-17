import { describe, expect, it } from "vitest";
import type {
  LlmSlotInfo,
  ModelCapabilityInfo,
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
  it.each([undefined, null])(
    "normalizes partial overrides when the lookup is %s",
    (lookup) => {
      expect(
        resolveDisplayCapability(lookup, server.capability, {
          contextWindow: 64_000,
        }),
      ).toEqual({
        input: ["text"],
        output: ["text"],
        contextWindow: 64_000,
        maxOutputTokens: 384_000,
      });
    },
  );

  it.each<{
    override: Partial<ModelCapabilityInfo>;
    input: ModelCapabilityInfo["input"];
    output: ModelCapabilityInfo["output"];
  }>([
    { override: { input: ["image"] }, input: ["image"], output: ["text"] },
    { override: { output: ["audio"] }, input: ["text"], output: ["audio"] },
    { override: { input: [], output: [] }, input: [], output: [] },
  ])(
    "preserves explicit modalities in $override",
    ({ override, input, output }) => {
      expect(resolveDisplayCapability(undefined, undefined, override)).toEqual({
        input,
        output,
      });
    },
  );

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
      parameterDefaults: undefined,
    });
    const displayed = resolveDisplayCapability(fallback, target.baseCapability);
    expect(displayed?.contextWindow).toBeUndefined();
    expect(displayed?.maxOutputTokens).toBeUndefined();
  });

  it("inherits parameter defaults only from the currently selected target", () => {
    const defaults = { maxOutputTokens: 4096, temperature: 0.2 };
    expect(
      resolveEffectiveModelTarget(undefined, {
        ...server,
        parameterOverrides: defaults,
      }).parameterDefaults,
    ).toEqual(defaults);
    expect(
      resolveEffectiveModelTarget(
        { provider: "custom", model: "another" },
        { ...server, parameterOverrides: defaults },
      ).parameterDefaults,
    ).toBeUndefined();
    expect(
      resolveEffectiveModelTarget(
        { provider: "custom", model: "another", parameterOverrides: defaults },
        server,
      ).parameterDefaults,
    ).toEqual(defaults);
  });

  it("does not inherit another provider's protocol when the bound model omits one", () => {
    const target = resolveEffectiveModelTarget(
      { provider: "custom-connection", model: "opaque-id" },
      { ...server, protocol: "anthropic-v1" },
    );
    expect(target.protocol).toBe("openai-chat-v1");
  });

  it("keeps protocol estimates unknown while honoring explicit server and user limits", () => {
    expect(resolveDisplayCapability(fallback)?.maxOutputTokens).toBeUndefined();
    expect(
      resolveDisplayCapability(fallback, server.capability)?.maxOutputTokens,
    ).toBe(384_000);
    expect(
      resolveDisplayCapability(fallback, server.capability, {
        maxOutputTokens: 12_000,
      })?.maxOutputTokens,
    ).toBe(12_000);
    expect(
      resolveDisplayCapability(null, server.capability)?.maxOutputTokens,
    ).toBe(384_000);
  });

  it("uses the selected preset's own capability even without a catalog match", () => {
    const capability = {
      input: ["text" as const],
      output: ["text" as const],
      contextWindow: 16384,
      maxOutputTokens: 8192,
    };
    const target = resolveEffectiveModelTarget(
      { provider: "custom", model: "opaque", capability },
      server,
    );
    expect(
      resolveDisplayCapability(fallback, target.baseCapability),
    ).toMatchObject(capability);
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
