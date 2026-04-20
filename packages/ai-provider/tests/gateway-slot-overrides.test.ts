import { describe, it, expect, beforeEach } from "vitest";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import { createSlotRegistry } from "../src/slot-registry.js";
import { __internals } from "../src/slot-overlay.js";
import type {
  ModelProfile,
  PresetConfig,
  TextGenerationResult,
  StreamEvent,
  SlotOverridesInput,
} from "../src/types.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";

// ── Tracking mock adapter ──────────────────────────────────────────

interface AdapterCall {
  provider: string;
  method: "generateText" | "streamText";
  model: string;
  baseUrl: string | undefined;
  apiKey: string | undefined;
}

function createRecordingAdapter(
  provider: string,
  calls: AdapterCall[],
): ModelProviderAdapter {
  return {
    async generateText(config, params) {
      calls.push({
        provider,
        method: "generateText",
        model: params.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      });
      return {
        text: `reply from ${provider}/${params.model}`,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async *streamText(config, params) {
      calls.push({
        provider,
        method: "streamText",
        model: params.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      });
      yield { type: "text-delta" as const, textDelta: "hi" };
      yield {
        type: "done" as const,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async generateObject<TObject>() {
      return {
        object: {} as TObject,
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    async embed() {
      return { embeddings: [[0]], usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async generateImage() {
      return { images: [], usage: null };
    },
    async synthesizeSpeech() {
      return {
        audio: { mimeType: "audio/mp3", data: new Uint8Array() },
        usage: null,
      };
    },
    async transcribeAudio() {
      return { text: "", usage: null };
    },
  };
}

// ── Fixture ────────────────────────────────────────────────────────

const profiles: ModelProfile[] = [];
const basePresets: PresetConfig[] = [
  {
    id: "ds-chat",
    name: "DeepSeek Chat (base)",
    provider: "deepseek",
    model: "deepseek-chat",
    protocol: "openai-chat-v1",
    tier: "medium",
    supportedModes: ["text", "stream"],
    enabled: true,
    tag: "text",
  },
];

function setup() {
  const calls: AdapterCall[] = [];
  const providerRegistry = createProviderRegistry({
    providers: {
      // Base provider (present in llm.toml equivalent).
      deepseek: {
        adapter: createRecordingAdapter("deepseek", calls),
        defaults: { baseUrl: "https://api.deepseek.com", protocol: "openai-chat-v1" },
      },
      // Custom provider declared up-front so we can record calls against it
      // without the overlay's provider registration running (since hasProvider
      // would then return true and short-circuit it).
      vendorX: {
        adapter: createRecordingAdapter("vendorX", calls),
        defaults: {
          baseUrl: "https://placeholder.example",
          protocol: "openai-chat-v1",
        },
      },
    },
  });

  const presetRegistry = createPresetRegistry({
    profiles,
    presets: basePresets,
  });

  const slotRegistry = createSlotRegistry({ presetRegistry });
  slotRegistry.configure({
    slots: {
      story: { slotId: "story", presetId: "ds-chat", tag: "text" },
    },
  });

  const gateway = createGateway({ providerRegistry, presetRegistry, slotRegistry });
  return { gateway, calls, providerRegistry, presetRegistry };
}

describe("gateway + slotOverrides", () => {
  beforeEach(() => {
    __internals.presetRefs.clear();
    __internals.providerRefs.clear();
  });

  it("routes a slot-name request through slotPresetOverrides to a client custom preset", async () => {
    const { gateway, calls, presetRegistry } = setup();
    const overrides: SlotOverridesInput = {
      slotPresetOverrides: { fast: "custom_abc" },
      customPresets: [
        {
          id: "custom_abc",
          name: "Vendor X Fast",
          provider: "vendorX",
          baseUrl: "https://api.vendorx.example/v1",
          model: "fast-7b",
          protocol: "openai-chat-v1",
        },
      ],
    };

    const result: TextGenerationResult = await gateway.generateText(
      { presetId: "fast", messages: [{ role: "user", content: "hi" }] },
      { apiKeys: { vendorX: "sk-vendorX-TEST" }, slotOverrides: overrides },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.provider).toBe("vendorX");
    expect(call.model).toBe("fast-7b");
    // The overlay-registered preset carries a `baseUrl`, so it must
    // reach the adapter config ahead of the provider's placeholder default.
    expect(call.baseUrl).toBe("https://api.vendorx.example/v1");
    expect(call.apiKey).toBe("sk-vendorX-TEST");
    expect(result.text).toContain("vendorX/fast-7b");

    // Registry state restored after the call completes.
    expect(presetRegistry.hasPreset("custom_abc")).toBe(false);
    expect(__internals.presetRefs.has("custom_abc")).toBe(false);
  });

  it("streamText applies and rolls back the overlay even when the stream completes", async () => {
    const { gateway, calls, presetRegistry } = setup();
    const overrides: SlotOverridesInput = {
      customPresets: [
        {
          id: "custom_stream",
          name: "Streamer",
          provider: "vendorX",
          baseUrl: "https://stream.vendorx.example/v1",
          model: "streamer-3b",
          protocol: "openai-chat-v1",
        },
      ],
    };

    const events: StreamEvent[] = [];
    for await (const event of gateway.streamText(
      { presetId: "custom_stream", messages: [{ role: "user", content: "hi" }] },
      { apiKeys: { vendorX: "sk-stream-TEST" }, slotOverrides: overrides },
    )) {
      events.push(event);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      provider: "vendorX",
      method: "streamText",
      model: "streamer-3b",
      baseUrl: "https://stream.vendorx.example/v1",
      apiKey: "sk-stream-TEST",
    });
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);

    // Cleanup happened even though the generator completed normally.
    expect(presetRegistry.hasPreset("custom_stream")).toBe(false);
    expect(__internals.presetRefs.has("custom_stream")).toBe(false);
  });

  it("rolls back the overlay even when the call throws", async () => {
    const calls: AdapterCall[] = [];
    const providerRegistry = createProviderRegistry({
      providers: {
        vendorX: {
          adapter: {
            async generateText() {
              throw new Error("boom");
            },
            async *streamText() {
              throw new Error("boom stream");
            },
            async generateObject<TObject>() {
              throw new Error("boom obj");
              return {
                object: {} as TObject,
                finishReason: "stop",
                usage: { inputTokens: 0, outputTokens: 0 },
              };
            },
            async embed() {
              throw new Error("boom embed");
            },
            async generateImage() {
              throw new Error("boom image");
            },
            async synthesizeSpeech() {
              throw new Error("boom speech");
            },
            async transcribeAudio() {
              throw new Error("boom transcribe");
            },
          },
          defaults: { baseUrl: "https://placeholder.example", protocol: "openai-chat-v1" },
        },
      },
    });
    const presetRegistry = createPresetRegistry({ profiles, presets: basePresets });
    const slotRegistry = createSlotRegistry({ presetRegistry });
    slotRegistry.configure({
      slots: { story: { slotId: "story", presetId: "ds-chat", tag: "text" } },
    });
    const gateway = createGateway({ providerRegistry, presetRegistry, slotRegistry });

    const overrides: SlotOverridesInput = {
      customPresets: [
        {
          id: "custom_err",
          name: "Err",
          provider: "vendorX",
          baseUrl: "https://err.example",
          model: "err-m",
          protocol: "openai-chat-v1",
        },
      ],
    };

    await expect(
      gateway.generateText(
        { presetId: "custom_err", messages: [{ role: "user", content: "hi" }] },
        { slotOverrides: overrides },
      ),
    ).rejects.toThrow();

    // Even with the throw, the registry must be clean again.
    expect(presetRegistry.hasPreset("custom_err")).toBe(false);
    expect(__internals.presetRefs.has("custom_err")).toBe(false);
    expect(calls).toHaveLength(0); // we never reach the recorder
  });

  it("falls through to the slot registry when no client override matches", async () => {
    const { gateway, calls } = setup();

    await gateway.generateText(
      { presetId: "story", messages: [{ role: "user", content: "hi" }] },
      {
        apiKeys: { deepseek: "sk-deepseek-TEST" },
        slotOverrides: { slotPresetOverrides: { fast: "custom_abc" } },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].provider).toBe("deepseek");
    expect(calls[0].model).toBe("deepseek-chat");
    expect(calls[0].apiKey).toBe("sk-deepseek-TEST");
  });
});
