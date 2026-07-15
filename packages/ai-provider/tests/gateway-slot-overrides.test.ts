import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  providerRequestMetadata?: Record<string, unknown>;
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
        providerRequestMetadata: params.providerRequestMetadata,
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
        providerRequestMetadata: params.providerRequestMetadata,
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
        defaults: {
          baseUrl: "https://api.deepseek.com",
          protocol: "openai-chat-v1",
        },
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

  const gateway = createGateway({
    providerRegistry,
    presetRegistry,
    slotRegistry,
  });
  return { gateway, calls, providerRegistry, presetRegistry };
}

describe("gateway + slotOverrides", () => {
  beforeEach(() => {
    __internals.presetRefs.clear();
    __internals.providerRefs.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("forwards slot-level parameter overrides into providerRequestMetadata", async () => {
    const { gateway, calls } = setup();
    const overrides: SlotOverridesInput = {
      parameterOverrides: {
        story: {
          temperature: 0.3,
          topP: 0.8,
          maxOutputTokens: 777,
        },
      },
    };

    await gateway.generateText(
      { presetId: "story", messages: [{ role: "user", content: "hi" }] },
      { slotOverrides: overrides },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].providerRequestMetadata).toMatchObject({
      parameterOverrides: {
        temperature: 0.3,
        topP: 0.8,
        maxOutputTokens: 777,
      },
    });
  });

  it("lets top-level parameter overrides win over request-scoped slot overrides", async () => {
    const { gateway, calls } = setup();

    await gateway.generateText(
      {
        presetId: "story",
        messages: [{ role: "user", content: "hi" }],
      },
      {
        parameterOverrides: {
          temperature: 0.1,
          maxOutputTokens: 128,
        },
        slotOverrides: {
          parameterOverrides: {
            story: {
              temperature: 0.9,
              maxOutputTokens: 999,
            },
          },
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].providerRequestMetadata).toMatchObject({
      parameterOverrides: {
        temperature: 0.1,
        maxOutputTokens: 128,
      },
    });
  });

  it("applies provider metadata precedence before resolved parameter overrides", async () => {
    const calls: AdapterCall[] = [];
    const providerRegistry = createProviderRegistry({
      providers: {
        deepseek: {
          adapter: createRecordingAdapter("deepseek", calls),
          defaults: {
            baseUrl: "https://api.deepseek.com",
            protocol: "openai-chat-v1",
          },
        },
      },
    });
    const presetRegistry = createPresetRegistry({
      profiles,
      presets: [
        {
          ...basePresets[0],
          providerRequestMetadata: {
            reasoningEffort: "low",
            parameterOverrides: {
              temperature: 0.8,
            },
          },
        },
      ],
    });
    const slotRegistry = createSlotRegistry({ presetRegistry });
    slotRegistry.configure({
      slots: {
        story: {
          slotId: "story",
          presetId: "ds-chat",
          tag: "text",
          parameterOverrides: {
            temperature: 0.2,
            topP: 0.7,
          },
        },
      },
    });
    const gateway = createGateway({
      providerRegistry,
      presetRegistry,
      slotRegistry,
    });

    await gateway.generateText({
      presetId: "story",
      messages: [{ role: "user", content: "hi" }],
      providerRequestMetadata: {
        reasoningEffort: "high",
        userFlag: true,
        parameterOverrides: {
          temperature: 0.6,
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].providerRequestMetadata).toEqual({
      reasoningEffort: "high",
      userFlag: true,
      parameterOverrides: {
        temperature: 0.2,
        topP: 0.7,
      },
    });
  });

  it("uses original slot id for resolveSlot parameter overrides during fallback", () => {
    const { gateway } = setup();

    const resolved = gateway.resolveSlot("plugin", {
      slotOverrides: {
        parameterOverrides: {
          plugin: { temperature: 0.4 },
          story: { temperature: 0.8 },
        },
      },
    });

    expect(resolved?.presetId).toBe("ds-chat");
    expect(resolved?.parameterOverrides).toEqual({ temperature: 0.4 });
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
      {
        presetId: "custom_stream",
        messages: [{ role: "user", content: "hi" }],
      },
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
          },
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
      slots: { story: { slotId: "story", presetId: "ds-chat", tag: "text" } },
    });
    const gateway = createGateway({
      providerRegistry,
      presetRegistry,
      slotRegistry,
    });

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

  it("never leaks env keys to a custom preset that redirects an existing provider (S-01)", async () => {
    const { gateway, calls } = setup();
    // Attack: reuse the env-keyed provider name, redirect baseUrl, send NO
    // request key. The env key must not follow the redirected origin.
    const overrides: SlotOverridesInput = {
      customPresets: [
        {
          id: "evil",
          name: "evil",
          provider: "deepseek",
          baseUrl: "https://attacker.example",
          model: "deepseek-chat",
        },
      ],
    };

    await gateway.generateText(
      { presetId: "evil", messages: [{ role: "user", content: "hi" }] },
      { envApiKeys: { deepseek: "sk-env-SECRET" }, slotOverrides: overrides },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].baseUrl).toBe("https://attacker.example");
    expect(calls[0].apiKey).toBeUndefined();
  });

  it("still applies env keys to trusted presets and custom presets without baseUrl", async () => {
    const { gateway, calls } = setup();

    // Trusted llm.toml preset — env key applies.
    await gateway.generateText(
      { presetId: "story", messages: [{ role: "user", content: "hi" }] },
      { envApiKeys: { deepseek: "sk-env-SECRET" } },
    );
    // Custom preset that only changes the model (trusted default origin).
    await gateway.generateText(
      { presetId: "custom_model", messages: [{ role: "user", content: "hi" }] },
      {
        envApiKeys: { deepseek: "sk-env-SECRET" },
        slotOverrides: {
          customPresets: [
            {
              id: "custom_model",
              name: "Custom model",
              provider: "deepseek",
              model: "deepseek-reasoner",
            },
          ],
        },
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].apiKey).toBe("sk-env-SECRET");
    expect(calls[1].apiKey).toBe("sk-env-SECRET");
    expect(calls[1].model).toBe("deepseek-reasoner");
  });

  it("strips env keys from resolveSlot for redirected custom presets (S-01)", () => {
    const { gateway } = setup();

    const redirected = gateway.resolveSlot("evil", {
      envApiKeys: { deepseek: "sk-env-SECRET" },
      slotOverrides: {
        customPresets: [
          {
            id: "evil",
            name: "evil",
            provider: "deepseek",
            baseUrl: "https://attacker.example",
            model: "deepseek-chat",
          },
        ],
      },
    });
    expect(redirected?.baseUrl).toBe("https://attacker.example");
    expect(redirected?.apiKey).toBeUndefined();

    const trusted = gateway.resolveSlot("story", {
      envApiKeys: { deepseek: "sk-env-SECRET" },
    });
    expect(trusted?.apiKey).toBe("sk-env-SECRET");
  });

  it("sends no Authorization header to the redirected origin at the HTTP layer (S-01)", async () => {
    // Real builtin openai-chat adapter (no programmatic adapter registered)
    // + stubbed fetch: proves the outgoing request itself carries no env key.
    const providerRegistry = createProviderRegistry({
      providerDefaults: {
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          protocol: "openai-chat-v1",
        },
      },
    });
    const presetRegistry = createPresetRegistry({
      profiles,
      presets: basePresets,
    });
    const slotRegistry = createSlotRegistry({ presetRegistry });
    const gateway = createGateway({
      providerRegistry,
      presetRegistry,
      slotRegistry,
    });

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await gateway.generateText(
      { presetId: "evil", messages: [{ role: "user", content: "hi" }] },
      {
        envApiKeys: { deepseek: "sk-env-SECRET" },
        slotOverrides: {
          customPresets: [
            {
              id: "evil",
              name: "evil",
              provider: "deepseek",
              baseUrl: "https://attacker.example",
              model: "deepseek-chat",
              protocol: "openai-chat-v1",
            },
          ],
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url.startsWith("https://attacker.example")).toBe(true);
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(JSON.stringify(init.headers)).not.toContain("sk-env-SECRET");
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
