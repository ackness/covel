import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import { AiProviderError } from "../src/errors.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";
import type { PresetConfig } from "../src/types.js";

const usage = { inputTokens: 1, outputTokens: 1 };

function setup(statusCode?: number) {
  const calls: Array<{ model: string; output: unknown }> = [];
  const record = (model: string, metadata?: Record<string, unknown>) => {
    calls.push({
      model,
      output: (metadata?.parameterOverrides as Record<string, unknown>)
        ?.maxOutputTokens,
    });
    if (statusCode && model === "primary") {
      throw new AiProviderError({
        code: statusCode === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR",
        message: "Synthetic upstream failure",
        provider: "fixture",
        statusCode,
        retriable: statusCode === 429 || statusCode >= 500,
      });
    }
  };
  const adapter: ModelProviderAdapter = {
    async generateText(_config, params) {
      record(params.model, params.providerRequestMetadata);
      return { text: "ok", finishReason: "stop", usage };
    },
    async generateObject<T>(
      _config: unknown,
      params: {
        model: string;
        providerRequestMetadata?: Record<string, unknown>;
      },
    ) {
      record(params.model, params.providerRequestMetadata);
      return { object: {} as T, finishReason: "stop", usage };
    },
    async *streamText(_config, params) {
      record(params.model, params.providerRequestMetadata);
      yield { type: "text-delta", textDelta: "ok" };
      yield { type: "done", finishReason: "stop", usage };
    },
    async embed() {
      return { embeddings: [], usage };
    },
  };
  const preset = (id: string, maxOutputTokens: number): PresetConfig => ({
    id,
    name: id,
    provider: "fixture",
    model: id,
    tier: "medium",
    enabled: true,
    supportedModes: ["text", "object", "stream"],
    capability: { contextWindow: 131_072, maxOutputTokens },
    ...(id === "primary"
      ? { isDefault: true, fallbackPresetIds: ["backup"] }
      : {}),
  });
  const presetRegistry = createPresetRegistry({
    profiles: [],
    presets: [preset("primary", 65_536), preset("backup", 8192)],
  });
  const providerRegistry = createProviderRegistry({
    providers: {
      fixture: {
        adapter,
        defaults: {
          baseUrl: "https://fixture.example",
          protocol: "openai-chat-v1",
        },
      },
    },
  });
  return {
    gateway: createGateway({ presetRegistry, providerRegistry }),
    calls,
    presetRegistry,
  };
}

describe("gateway target output budgets", () => {
  it.each(["generate", "stream"] as const)(
    "%s identifies provider setup failures before I/O",
    async (mode) => {
      const { gateway, calls, presetRegistry } = setup();
      presetRegistry.addPreset({
        ...presetRegistry.resolvePreset("primary")!,
        provider: "missing-provider",
      });
      const invoke = async () => {
        if (mode === "generate")
          return gateway.generateText({
            messages: [{ role: "user", content: "hi" }],
          });
        for await (const _ of gateway.streamText({
          messages: [{ role: "user", content: "hi" }],
        })) {
          /* drain */
        }
      };
      await expect(invoke()).rejects.toMatchObject({
        code: "CONFIG_ERROR",
        provider: "missing-provider",
        model: "primary",
        message: expect.stringContaining("model: primary"),
      });
      expect(calls).toEqual([]);
    },
  );

  it("does not retry another model with an invalid output parameter", async () => {
    const { gateway, calls } = setup();
    await expect(
      gateway.generateText(
        { messages: [{ role: "user", content: "hi" }] },
        { parameterOverrides: { maxOutputTokens: 0 } },
      ),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR", model: "primary" });
    expect(calls).toEqual([]);
  });
  it.each(["generate", "object", "stream"] as const)(
    "%s clamps output again when falling back to a smaller model",
    async (mode) => {
      const { gateway, calls } = setup(503);
      const input = {
        presetId: "primary",
        messages: [{ role: "user" as const, content: "hi" }],
      };
      const options = { parameterOverrides: { maxOutputTokens: 32_768 } };
      if (mode === "generate") await gateway.generateText(input, options);
      else if (mode === "object")
        await gateway.generateObject(
          { ...input, schema: z.object({}) },
          options,
        );
      else
        for await (const _event of gateway.streamText(input, options)) {
          /* drain */
        }
      expect(calls).toEqual([
        { model: "primary", output: 32_768 },
        { model: "backup", output: 8192 },
      ]);
      expect(options.parameterOverrides.maxOutputTokens).toBe(32_768);
    },
  );

  it("uses 16k for direct gateway calls without a runtime budget", async () => {
    const { gateway, calls } = setup();
    expect(gateway.resolveSlot(undefined)).toMatchObject({
      model: "primary",
      capability: { contextWindow: 131_072, maxOutputTokens: 65_536 },
    });
    await gateway.generateText({ messages: [{ role: "user", content: "hi" }] });
    expect(calls).toEqual([{ model: "primary", output: 16_384 }]);
  });

  it("exposes persisted output requests before a runtime chooses its reserve", async () => {
    const { gateway, calls, presetRegistry } = setup();
    presetRegistry.addPreset({
      ...presetRegistry.resolvePreset("primary")!,
      providerRequestMetadata: {
        parameterOverrides: { maxOutputTokens: 4096 },
      },
    });
    const resolved = gateway.resolveSlot("primary");
    expect(resolved?.parameterOverrides?.maxOutputTokens).toBe(4096);
    await gateway.generateText(
      { presetId: "primary", messages: [{ role: "user", content: "hi" }] },
      {
        parameterOverrides: {
          maxOutputTokens: resolved!.parameterOverrides!.maxOutputTokens,
        },
      },
    );
    expect(calls).toEqual([{ model: "primary", output: 4096 }]);
  });

  it.each(["generate", "stream"] as const)(
    "%s falls back on 429",
    async (mode) => {
      const { gateway, calls } = setup(429);
      const input = { messages: [{ role: "user" as const, content: "hi" }] };
      if (mode === "generate") await gateway.generateText(input);
      else
        for await (const _event of gateway.streamText(input)) {
          /* drain */
        }
      expect(calls.map((call) => call.model)).toEqual(["primary", "backup"]);
    },
  );

  it.each([400, 401, 403])(
    "preserves terminal HTTP %s failures",
    async (status) => {
      const { gateway, calls } = setup(status);
      await expect(
        gateway.generateText({ messages: [{ role: "user", content: "hi" }] }),
      ).rejects.toMatchObject({ statusCode: status, model: "primary" });
      expect(calls).toHaveLength(1);
    },
  );
});
