import { afterEach, describe, expect, it } from "vitest";

import {
  createModelDatabase,
  modelLookupCandidates,
  resolveCapabilityDetails,
  setModelDatabase,
  type ModelDbFile,
} from "../src/index.js";

afterEach(() => setModelDatabase(null));

describe("model identity resolution", () => {
  it("keeps the routed model id and adds namespace/model-name candidates", () => {
    expect(modelLookupCandidates("openai/gpt-5.6-sol", "openai")).toEqual([
      "openai/gpt-5.6-sol",
      "gpt-5.6-sol",
    ]);

    expect(
      modelLookupCandidates("openai/deepseek/deepseek-v4-flash", "openai"),
    ).toEqual([
      "openai/deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash",
      "deepseek-v4-flash",
    ]);
  });

  it("recognizes a namespaced DeepSeek model without rewriting the request id", () => {
    const result = resolveCapabilityDetails(
      "deepseek/deepseek-v4-flash",
      "openai",
      "openai-chat-v1",
    );

    expect(result).toMatchObject({
      source: "known",
      matchedModelId: "deepseek-v4-flash",
      matchKind: "model-name",
      pricingKind: "reference",
    });
    expect(result.capability).toMatchObject({
      input: ["text"],
      output: ["text"],
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      pricing: { inputPerMToken: 0.14, outputPerMToken: 0.28 },
    });
    expect(result.capability.features).toEqual(
      expect.arrayContaining(["function_calling", "reasoning"]),
    );
  });

  it("reports the database key and reference pricing for aggregator matches", () => {
    const data: ModelDbFile = {
      updatedAt: "2026-08-14T00:00:00.000Z",
      source: "test",
      count: 1,
      models: {
        "openai/gpt-example": {
          input: ["text", "image"],
          output: ["text"],
          features: ["vision"],
          contextWindow: 128_000,
          maxOutputTokens: 16_000,
          mode: "chat",
          litellmProvider: "openai",
          inputPerMToken: 2,
          outputPerMToken: 8,
        },
      },
    };
    setModelDatabase(createModelDatabase(data));

    const result = resolveCapabilityDetails(
      "openai/gpt-example",
      "openai",
      "openai-chat-v1",
    );

    expect(result).toMatchObject({
      source: "model-database",
      matchedModelId: "openai/gpt-example",
      matchKind: "exact",
      pricingKind: "provider",
    });
    expect(result.capability.input).toEqual(["text", "image"]);
  });

  it("marks protocol defaults as unrecognized", () => {
    const result = resolveCapabilityDetails(
      "vendor/brand-new-model",
      "openai",
      "openai-chat-v1",
    );

    expect(result).toMatchObject({
      source: "protocol-default",
      pricingKind: "unknown",
    });
    expect(result.matchedModelId).toBeUndefined();
  });
});
