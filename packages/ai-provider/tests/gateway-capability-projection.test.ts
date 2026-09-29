import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../src/gateway.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";
import type {
  ModelCapability,
  ModelRequestContext,
  PresetConfig,
} from "../src/types.js";

const capability: ModelCapability = {
  input: ["text", "image", "audio", "video", "file"],
  output: ["text", "image", "audio"],
  features: ["function_calling", "vision", "web_search", "computer_use"],
};
const preset: PresetConfig = {
  id: "main",
  name: "Main",
  provider: "fixture",
  model: "model",
  protocol: "openai-responses-v1",
  enabled: true,
  isDefault: true,
  supportedModes: ["text", "object", "stream"],
  tier: "medium",
  tag: "text",
  capability,
};
const expected = {
  input: ["text", "image"],
  output: ["text"],
  features: ["function_calling", "vision"],
};

describe("effective gateway capabilities", () => {
  it("projects built-in support after full request overrides without mutating the preset", () => {
    const registry = createProviderRegistry({
      providerDefaults: {
        fixture: {
          baseUrl: "https://fixture.example",
          protocol: "openai-responses-v1",
        },
      },
    });
    const gateway = createGateway({
      providerRegistry: registry,
      presetRegistry: createPresetRegistry({ profiles: [], presets: [preset] }),
    });
    const result = gateway.resolveSlot("main", {
      capabilityOverridePolicy: "full",
      slotOverrides: { capabilityOverrides: { main: capability } },
    });
    expect(result?.capability).toMatchObject(expected);
    expect(preset.capability).toEqual(capability);
  });

  it("uses the same projected capability in the adapter context", async () => {
    const registry = createProviderRegistry({
      providerDefaults: {
        fixture: {
          baseUrl: "https://fixture.example",
          protocol: "openai-responses-v1",
        },
      },
    });
    const resolve = registry.resolve;
    let context: ModelRequestContext | undefined;
    vi.spyOn(registry, "resolve").mockImplementation((...args) => {
      const resolution = resolve(...args);
      return {
        ...resolution,
        adapter: {
          ...resolution.adapter,
          async generateText(_config, _params, ctx) {
            context = ctx;
            return {
              text: "ok",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        },
      };
    });
    const gateway = createGateway({
      providerRegistry: registry,
      presetRegistry: createPresetRegistry({ profiles: [], presets: [preset] }),
    });
    await gateway.generateText(
      { messages: [{ role: "user", content: "hello" }] },
      {
        capabilityOverridePolicy: "full",
        slotOverrides: { capabilityOverrides: { main: capability } },
      },
    );
    expect(context?.preset?.capability).toMatchObject(expected);
  });

  it("warns when the model ignores a protocol-level reasoning option", async () => {
    const registry = createProviderRegistry({
      providerDefaults: {
        fixture: {
          baseUrl: "https://fixture.example",
          protocol: "openai-chat-v1",
        },
      },
    });
    const resolve = registry.resolve;
    vi.spyOn(registry, "resolve").mockImplementation((...args) => {
      const resolution = resolve(...args);
      return {
        ...resolution,
        adapter: {
          ...resolution.adapter,
          async generateText() {
            return {
              text: "ok",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        },
      };
    });
    const gateway = createGateway({
      providerRegistry: registry,
      presetRegistry: createPresetRegistry({
        profiles: [],
        presets: [{ ...preset, protocol: "openai-chat-v1", model: "gpt-4o" }],
      }),
    });
    const result = await gateway.generateText({
      messages: [{ role: "user", content: "hello" }],
      providerOptions: { fixture: { reasoningEffort: "high" } },
    });
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({
        type: "unsupported",
        feature: "reasoningEffort",
      }),
    );
  });

  it("leaves capabilities owned by custom adapters and separate media roles intact", () => {
    const builtinRegistry = createProviderRegistry({
      providerDefaults: {
        fixture: {
          baseUrl: "https://fixture.example",
          protocol: "openai-responses-v1",
        },
      },
    });
    const adapter: ModelProviderAdapter =
      builtinRegistry.resolve(preset).adapter;
    const customRegistry = createProviderRegistry({
      providers: {
        fixture: { adapter, defaults: { baseUrl: "https://fixture.example" } },
      },
    });
    const custom = createGateway({
      providerRegistry: customRegistry,
      presetRegistry: createPresetRegistry({ profiles: [], presets: [preset] }),
    });
    expect(custom.resolveSlot("main")?.capability).toEqual(capability);
    const media = createGateway({
      providerRegistry: builtinRegistry,
      presetRegistry: createPresetRegistry({
        profiles: [],
        presets: [
          {
            ...preset,
            tag: "transcription",
            capability: { input: ["audio"], output: ["text"] },
          },
        ],
      }),
    });
    expect(
      media.resolveSlot("main", { fallbackTag: "transcription" })?.capability,
    ).toEqual({ input: ["audio"], output: ["text"] });
  });
});
