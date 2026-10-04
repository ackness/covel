import { expect, it, vi } from "vitest";
import { parsePluginLlmToml } from "@covel/plugin-loader";
import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
} from "@covel/ai-provider";
import type { ModelProviderAdapter } from "@covel/ai-provider";
import {
  createModelResolver,
  type PluginLlmModelTarget,
} from "../src/llm/model-resolver.js";
import { createGatewayAdapter } from "../src/llm/gateway-llm-adapter.js";

it("dispatches full plugin targets after system reload, with request/runtime selections taking priority", async () => {
  const generateText = vi.fn<ModelProviderAdapter["generateText"]>(
    async () => ({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  );
  const streamText = vi.fn<ModelProviderAdapter["streamText"]>(
    async function* () {
      yield { type: "text-delta" as const, textDelta: "ok" };
      yield {
        type: "done" as const,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  );
  const providerRegistry = createProviderRegistry({
    providers: {
      vendor: {
        adapter: {
          generateText,
          streamText,
          generateObject: vi.fn(),
          embed: vi.fn(),
        } as ModelProviderAdapter,
        defaults: {
          baseUrl: "https://trusted.example/v1",
          protocol: "openai-chat-v1",
        },
      },
    },
  });
  const presets = [
    {
      id: "system",
      name: "System",
      provider: "vendor",
      model: "system-model",
      protocol: "openai-chat-v1" as const,
      tier: "medium" as const,
      supportedModes: ["text" as const, "stream" as const],
      enabled: true,
      isDefault: true,
    },
  ];
  const presetRegistry = createPresetRegistry({ profiles: [], presets });
  const slotRegistry = createSlotRegistry();
  slotRegistry.configure({
    slots: { fast: { slotId: "fast", presetId: "system", tag: "text" } },
  });
  const gateway = createGateway({
    providerRegistry,
    presetRegistry,
    slotRegistry,
  });
  const modelTargets = new Map<string, PluginLlmModelTarget>();
  const manifest = {
    name: "runtime",
    description: "test",
    stage: "narrative" as const,
    model: "fast",
  };
  const resolve = createModelResolver({
    modelTargets,
    pluginLlmConfigs: new Map([
      [
        "runtime",
        parsePluginLlmToml(`
[plugin.fast]
provider = "vendor"
model = "plugin-model"
baseUrl = "https://plugin.example/v1"
protocol = "anthropic-messages-v1"
`),
      ],
    ]),
  });
  const model = resolve(manifest);
  expect(model).not.toBe("plugin-model");
  const adapter = createGatewayAdapter(gateway, {
    modelTargets,
    apiKeys: { vendor: "request-key" },
    envApiKeys: { vendor: "server-key" },
    slotOverrides: { parameterOverrides: { fast: { temperature: 0.25 } } },
  });
  presetRegistry.reconfigure({ profiles: [], presets });
  await adapter.generate({
    model,
    messages: [{ role: "user", content: "hello" }],
  });
  expect(generateText.mock.calls[0][0]).toMatchObject({
    baseUrl: "https://plugin.example/v1",
    apiKey: "request-key",
  });
  expect(generateText.mock.calls[0][1]).toMatchObject({
    model: "plugin-model",
    providerRequestMetadata: { parameterOverrides: { temperature: 0.25 } },
  });
  expect(generateText.mock.calls[0][2]?.preset?.protocol).toBe(
    "anthropic-messages-v1",
  );
  expect(adapter.resolveTarget?.(model)).toEqual({
    provider: "vendor",
    model: "plugin-model",
  });
  for await (const _event of adapter.stream!({
    model,
    messages: [{ role: "user", content: "hello" }],
  })) {
    /* consume */
  }
  expect(streamText).toHaveBeenCalled();
  // An explicit API override keeps system fast, even if plugin.fast exists.
  await adapter.generate({
    model: resolve(manifest, "fast"),
    messages: [{ role: "user", content: "hello" }],
  });
  expect(generateText.mock.calls[1][1]).toMatchObject({
    model: "system-model",
  });
  // Browser bindings retain the original role's parameters and replace plugin preference.
  const selected = createGatewayAdapter(gateway, {
    modelTargets,
    slotOverrides: {
      slotBindings: { fast: { presetId: "system" } },
      parameterOverrides: { fast: { temperature: 0.7 } },
    },
  });
  await selected.generate({
    model,
    messages: [{ role: "user", content: "hello" }],
  });
  expect(generateText.mock.calls[2][1]).toMatchObject({
    model: "system-model",
    providerRequestMetadata: { parameterOverrides: { temperature: 0.7 } },
  });
  // A plugin redirect never acquires a server key for another origin.
  await createGatewayAdapter(gateway, {
    modelTargets,
    envApiKeys: { vendor: "server-key" },
  }).generate({ model, messages: [{ role: "user", content: "hello" }] });
  expect(generateText.mock.calls[3][0].apiKey).toBeUndefined();
  expect(presetRegistry.listPresets().map((p) => p.id)).toEqual(["system"]);
});
