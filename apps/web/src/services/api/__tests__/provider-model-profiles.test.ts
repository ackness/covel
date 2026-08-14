import { describe, expect, it } from "vitest";

import {
  flattenProviderProfiles,
  profilesFromLegacyPresets,
  upsertProviderModel,
} from "../provider-model-profiles.js";

describe("provider model profiles", () => {
  it("groups legacy presets by provider and preserves stable model refs", () => {
    const profiles = profilesFromLegacyPresets([
      {
        id: "custom_openai",
        name: "OpenAI",
        provider: "openai",
        baseUrl: "https://openai.example/v1",
        model: "openai/gpt-5.6-sol",
        protocol: "openai-responses-v1",
      },
      {
        id: "custom_deepseek",
        name: "DeepSeek",
        provider: "openai",
        baseUrl: "https://openai.example/v1",
        model: "deepseek/deepseek-v4-flash",
        protocol: "openai-responses-v1",
      },
    ]);

    expect(profiles).toEqual([
      {
        id: "openai",
        name: "openai",
        baseUrl: "https://openai.example/v1",
        protocol: "openai-responses-v1",
        models: [
          {
            ref: "custom_openai",
            modelId: "openai/gpt-5.6-sol",
            name: "OpenAI",
          },
          {
            ref: "custom_deepseek",
            modelId: "deepseek/deepseek-v4-flash",
            name: "DeepSeek",
          },
        ],
      },
    ]);
  });

  it("flattens provider models into the existing request overlay shape", () => {
    const flattened = flattenProviderProfiles([
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://openai.example/v1",
        protocol: "openai-chat-v1",
        models: [
          { ref: "model_a", modelId: "openai/gpt-5.6-sol" },
          { ref: "model_b", modelId: "deepseek/deepseek-v4-flash" },
        ],
      },
    ]);

    expect(flattened).toEqual([
      {
        id: "model_a",
        name: "openai/gpt-5.6-sol",
        provider: "openai",
        baseUrl: "https://openai.example/v1",
        model: "openai/gpt-5.6-sol",
        protocol: "openai-chat-v1",
      },
      {
        id: "model_b",
        name: "deepseek/deepseek-v4-flash",
        provider: "openai",
        baseUrl: "https://openai.example/v1",
        model: "deepseek/deepseek-v4-flash",
        protocol: "openai-chat-v1",
      },
    ]);
  });

  it("adds multiple opaque model ids to one provider without rewriting them", () => {
    const first = upsertProviderModel(
      [],
      {
        providerId: "openai",
        baseUrl: "https://openai.example/v1",
        protocol: "openai-chat-v1",
        modelId: "openai/gpt-5.6-sol",
      },
      () => "model_a",
    );
    const second = upsertProviderModel(
      first.profiles,
      {
        providerId: "openai",
        baseUrl: "https://openai.example/v1",
        protocol: "openai-chat-v1",
        modelId: "deepseek/deepseek-v4-flash",
      },
      () => "model_b",
    );

    expect(second.modelRef).toBe("model_b");
    expect(second.profiles[0]?.models.map((model) => model.modelId)).toEqual([
      "openai/gpt-5.6-sol",
      "deepseek/deepseek-v4-flash",
    ]);
  });
});
