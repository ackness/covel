import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import { AiProviderError } from "../src/errors.js";
import { parseLlmConfig } from "../src/config/llm-loader.js";
import {
  resolveProviderOptions,
  type ProviderOptions,
} from "../src/provider-options.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";
import type { PresetConfig, TextGenerationParams } from "../src/types.js";

const usage = { inputTokens: 1, outputTokens: 1 };
const messages = [{ role: "user", content: "hello" }];

function setup(alternateEndpoint = false) {
  const requests: Array<{ provider: string; params: TextGenerationParams }> =
    [];
  const result = { text: "ok", finishReason: "stop", usage };
  const makeAdapter = (provider: string): ModelProviderAdapter => ({
    generateText: vi.fn(async (_config, params) => {
      requests.push({ provider, params });
      return result;
    }),
    async generateObject<T>() {
      return { object: { ok: true } as T, finishReason: "stop", usage };
    },
    async *streamText(_config, params) {
      requests.push({ provider, params });
      yield { type: "done", finishReason: "stop", usage };
    },
    async embed() {
      return { embeddings: [[1]], usage };
    },
  });
  const primary = makeAdapter("primary");
  const backup = makeAdapter("backup");
  const presets: PresetConfig[] = [
    {
      id: "primary",
      name: "Primary",
      provider: "primary",
      protocol: "openai-chat-v1",
      model: "m1",
      tier: "medium",
      supportedModes: ["text", "object", "stream"],
      enabled: true,
      isDefault: true,
      fallbackPresetIds: ["backup"],
      providerOptions: { primary: { store: true, seed: 1 } },
    },
    {
      id: "backup",
      name: "Backup",
      provider: "backup",
      protocol: "anthropic-messages-v1",
      model: "m2",
      tier: "medium",
      supportedModes: ["text", "object", "stream"],
      enabled: true,
      providerRequestMetadata: { ownExtension: true },
    },
  ];
  if (alternateEndpoint) {
    presets[1] = {
      ...presets[1]!,
      provider: "primary",
      protocol: "openai-chat-v1",
      baseUrl: "https://alternate.example",
    };
  }
  const gateway = createGateway({
    presetRegistry: createPresetRegistry({ presets, profiles: [] }),
    providerRegistry: createProviderRegistry({
      providers: {
        primary: {
          adapter: primary,
          defaults: { baseUrl: "https://primary.example" },
        },
        backup: {
          adapter: backup,
          defaults: { baseUrl: "https://backup.example" },
        },
      },
    }),
  });
  return { gateway, primary, backup, requests };
}

describe("target-scoped provider options", () => {
  it("validates and scopes native Gemini options without forwarding them to Chat", () => {
    const options: ProviderOptions = {
      google: {
        thinkingConfig: { thinkingLevel: "medium", includeThoughts: true },
        cachedContent: "cachedContents/synthetic-cache",
        seed: 7,
      },
    };
    expect(
      resolveProviderOptions(options, "google", "google-generative-ai-v1"),
    ).toEqual({ metadata: options.google, warnings: [] });
    const compatible = resolveProviderOptions(
      options,
      "google",
      "openai-chat-v1",
    );
    expect(compatible.metadata).toEqual({ seed: 7 });
    expect(compatible.warnings.map((warning) => warning.feature)).toEqual([
      "providerOptions.google.thinkingConfig",
      "providerOptions.google.cachedContent",
    ]);
  });

  it.each([
    { thinkingBudget: -2 },
    { thinkingBudget: 1.5 },
    { thinkingBudget: 1024, thinkingLevel: "low" },
    { thinkingLevel: "max" },
  ])("rejects invalid native thinking configuration %j", (thinkingConfig) => {
    expect(() =>
      resolveProviderOptions(
        { google: { thinkingConfig } } as ProviderOptions,
        "google",
        "google-generative-ai-v1",
      ),
    ).toThrow(AiProviderError);
  });

  it("protects native Gemini messages and generation limits in extraBody", () => {
    const resolved = resolveProviderOptions(
      {
        google: {
          extraBody: {
            contents: [],
            systemInstruction: { parts: [{ text: "replacement" }] },
            generationConfig: { maxOutputTokens: 999999 },
          },
        },
      },
      "google",
      "google-generative-ai-v1",
    );
    expect(resolved.metadata).toEqual({});
    expect(resolved.warnings).toHaveLength(3);
  });

  it("selects protocol defaults then active provider options and ignores inactive invalid options", () => {
    const options = {
      "openai-chat-v1": { store: false, seed: 2 },
      primary: { seed: 9 },
      backup: { thinking: "invalid" },
    } as unknown as ProviderOptions;
    expect(
      resolveProviderOptions(options, "primary", "openai-chat-v1"),
    ).toEqual({
      metadata: { store: false, seed: 9 },
      warnings: [],
    });
  });

  it("protects framework request fields in extraBody and reports their omission", () => {
    const resolved = resolveProviderOptions(
      {
        primary: {
          extraBody: {
            model: "other",
            stream: false,
            tools: [],
            max_tokens: 999999,
            custom_flag: true,
          },
        },
      },
      "primary",
      "openai-chat-v1",
    );
    expect(resolved.metadata).toEqual({ custom_flag: true });
    expect(resolved.warnings.map((warning) => warning.feature)).toEqual([
      "providerOptions.primary.extraBody.model",
      "providerOptions.primary.extraBody.stream",
      "providerOptions.primary.extraBody.tools",
      "providerOptions.primary.extraBody.max_tokens",
    ]);
  });

  it("normalizes typed reasoning into the same field as raw preset settings", () => {
    expect(
      resolveProviderOptions(
        { primary: { reasoningEffort: "disabled" } },
        "primary",
        "openai-chat-v1",
      ).metadata,
    ).toEqual({ reasoning_effort: "disabled" });
  });

  it("rejects malformed active options without invoking the adapter or fallback", async () => {
    const { gateway, primary, backup } = setup();
    await expect(
      gateway.generateText({
        messages,
        providerOptions: {
          primary: { store: "yes" },
        } as unknown as ProviderOptions,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR", retriable: false });
    expect(primary.generateText).not.toHaveBeenCalled();
    expect(backup.generateText).not.toHaveBeenCalled();
  });

  it("merges preset and call options with explicit wire extensions", async () => {
    const { gateway, requests } = setup();
    await gateway.generateText({
      messages,
      providerOptions: {
        primary: { seed: 42, extraBody: { custom_flag: true } },
      },
    });
    expect(requests[0]!.params.providerRequestMetadata).toMatchObject({
      store: true,
      seed: 42,
      custom_flag: true,
    });
    expect(requests[0]!.params.providerRequestMetadata).not.toHaveProperty(
      "providerOptions",
    );
  });

  it("only passes fallback options and portable settings after switching providers", async () => {
    const { gateway, primary, requests } = setup();
    vi.mocked(primary.generateText).mockRejectedValue(
      new AiProviderError({
        code: "PROVIDER_ERROR",
        provider: "primary",
        message: "unavailable",
        retriable: true,
      }),
    );
    const result = await gateway.generateText({
      messages,
      providerRequestMetadata: {
        enable_thinking: true,
        parameterOverrides: { temperature: 0.5 },
      },
      providerOptions: {
        primary: { store: true },
        backup: { thinking: { type: "enabled", budgetTokens: 2048 } },
      },
    });
    const metadata = requests[0]!.params.providerRequestMetadata;
    expect(metadata).toMatchObject({
      ownExtension: true,
      thinking: { type: "enabled", budget_tokens: 2048 },
      parameterOverrides: { temperature: 0.5 },
    });
    expect(metadata).not.toHaveProperty("store");
    expect(metadata).not.toHaveProperty("enable_thinking");
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({
        feature: "providerRequestMetadata",
        type: "compatibility",
      }),
    );
  });

  it("does not carry unscoped wire extensions to another endpoint of the same provider", async () => {
    const { gateway, primary, requests } = setup(true);
    vi.mocked(primary.generateText).mockRejectedValueOnce(
      new AiProviderError({
        code: "PROVIDER_ERROR",
        provider: "primary",
        message: "unavailable",
        retriable: true,
      }),
    );
    const result = await gateway.generateText({
      messages,
      providerRequestMetadata: { private_extension: "synthetic" },
    });
    expect(requests[0]!.params.providerRequestMetadata).not.toHaveProperty(
      "private_extension",
    );
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({ feature: "providerRequestMetadata" }),
    );
  });

  it("reports unsupported settings on text, object and streaming completions", async () => {
    const { gateway, requests } = setup();
    const providerOptions: ProviderOptions = {
      primary: { thinking: { type: "adaptive" } },
    };
    const text = await gateway.generateText({ messages, providerOptions });
    const object = await gateway.generateObject({
      messages,
      schema: z.object({ ok: z.boolean() }),
      providerOptions,
    });
    const stream = [];
    for await (const event of gateway.streamText({ messages, providerOptions }))
      stream.push(event);
    for (const result of [text, object, stream[0]]) {
      expect(result).toMatchObject({
        diagnostics: {
          warnings: [
            expect.objectContaining({
              type: "unsupported",
              feature: "providerOptions.primary.thinking",
            }),
          ],
        },
      });
    }
    expect(requests[0]!.params.providerRequestMetadata).not.toHaveProperty(
      "thinking",
    );
  });

  it.each([NaN, Infinity, -1, 0])(
    "rejects invalid maxOutputTokens %s before budget normalization",
    async (maxOutputTokens) => {
      const { gateway, primary } = setup();
      await expect(
        gateway.generateText(
          { messages },
          { parameterOverrides: { maxOutputTokens } },
        ),
      ).rejects.toMatchObject({ code: "CONFIG_ERROR", retriable: false });
      expect(primary.generateText).not.toHaveBeenCalled();
    },
  );

  it("warns when a portable setting has no translation on the selected protocol", async () => {
    const { gateway } = setup();
    const result = await gateway.generateText(
      { messages },
      { parameterOverrides: { topK: 10 } },
    );
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({
        feature: "parameterOverrides.topK",
        type: "unsupported",
      }),
    );
  });

  it("loads namespaced options from TOML without adding them to the raw metadata bag", () => {
    const loaded = parseLlmConfig(`
[covel.main]
provider = "openai"
model = "gpt-4o"
baseUrl = "https://api.example/v1"
protocol = "openai-chat-v1"
[covel.main.providerOptions.openai]
store = false
seed = 42
`);
    expect(loaded.aiConfig.presets[0]?.providerOptions).toEqual({
      openai: { store: false, seed: 42 },
    });
    expect(loaded.aiConfig.presets[0]?.providerRequestMetadata).toBeUndefined();
  });
});
