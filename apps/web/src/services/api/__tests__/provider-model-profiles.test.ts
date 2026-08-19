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

  it("keeps separate legacy connections for the same provider routable", () => {
    const legacy = [
      {
        id: "official_model",
        name: "Official",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5",
        protocol: "openai-responses-v1",
      },
      {
        id: "proxy_model",
        name: "Proxy",
        provider: "openai",
        baseUrl: "https://proxy.example/v1",
        model: "gpt-4.1",
        protocol: "openai-chat-v1",
      },
      {
        id: "proxy_responses_model",
        name: "Proxy Responses",
        provider: "openai",
        baseUrl: "https://proxy.example/v1",
        model: "gpt-5-mini",
        protocol: "openai-responses-v1",
      },
    ];

    const profiles = profilesFromLegacyPresets(legacy);
    const flattened = flattenProviderProfiles(profiles);

    expect(profiles).toHaveLength(3);
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(3);
    expect(new Set(flattened.map((preset) => preset.provider)).size).toBe(3);
    expect(
      flattened.map(({ provider: _provider, ...preset }) => preset),
    ).toEqual(legacy.map(({ provider: _provider, ...preset }) => preset));
  });

  it("normalizes provider ids before grouping legacy presets", () => {
    const profiles = profilesFromLegacyPresets([
      {
        id: "model_a",
        name: "A",
        provider: "openai",
        baseUrl: "https://openai.example/v1",
        model: "gpt-5",
      },
      {
        id: "model_b",
        name: "B",
        provider: "OpenAI",
        baseUrl: "https://openai.example/v1",
        model: "gpt-4.1",
      },
    ]);

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.id).toBe("openai");
    expect(profiles[0]?.models.map((model) => model.ref)).toEqual([
      "model_a",
      "model_b",
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

  it("normalizes provider ids before upserting a model", () => {
    const result = upsertProviderModel(
      [
        {
          id: "OpenAI",
          name: "OpenAI",
          baseUrl: "https://openai.example/v1",
          models: [{ ref: "model_a", modelId: "gpt-5" }],
        },
      ],
      {
        providerId: "openai",
        baseUrl: "https://openai.example/v1",
        modelId: "gpt-4.1",
      },
      () => "model_b",
    );

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]?.id).toBe("openai");
    expect(result.profiles[0]?.models.map((model) => model.ref)).toEqual([
      "model_a",
      "model_b",
    ]);
  });
});
