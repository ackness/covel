import { describe, expect, it } from "vitest";

import {
  flattenProviderProfiles,
  upsertProviderModel,
} from "../provider-model-profiles.js";

describe("provider model profiles", () => {
  it("keeps same-ID configurations independently addressable and exact additions idempotent", () => {
    const input = {
      providerId: "fixture",
      baseUrl: "https://fixture.invalid",
      modelId: "qwen3.8-flash",
    };
    const off = upsertProviderModel(
      [],
      { ...input, reasoningEffort: "disabled" },
      () => "off",
    );
    const on = upsertProviderModel(
      off.profiles,
      { ...input, reasoningEffort: "automatic" },
      () => "on",
    );
    const copy = upsertProviderModel(
      on.profiles,
      { ...input, reasoningEffort: "automatic", modelName: "Narration" },
      () => "copy",
    );
    const repeat = upsertProviderModel(
      copy.profiles,
      { ...input, reasoningEffort: "automatic" },
      () => "unexpected",
    );
    expect(repeat.modelRef).toBe("on");
    expect(repeat.profiles[0]!.models.map((model) => model.ref)).toEqual([
      "off",
      "on",
      "copy",
    ]);
    expect(
      flattenProviderProfiles(repeat.profiles).map(
        ({ id, name, model, reasoningEffort }) => ({
          id,
          name,
          model,
          reasoningEffort,
        }),
      ),
    ).toEqual([
      {
        id: "off",
        name: input.modelId,
        model: input.modelId,
        reasoningEffort: "disabled",
      },
      {
        id: "on",
        name: input.modelId,
        model: input.modelId,
        reasoningEffort: "automatic",
      },
      {
        id: "copy",
        name: "Narration",
        model: input.modelId,
        reasoningEffort: "automatic",
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
