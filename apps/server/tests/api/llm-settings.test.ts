import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
  type ModelProviderAdapter,
  type PresetConfig,
} from "@covel/ai-provider";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";

function setup() {
  const requests: Array<{ model: string; metadata?: Record<string, unknown> }> =
    [];
  const adapter = {
    async *streamText(_config, params) {
      requests.push({
        model: params.model,
        metadata: params.providerRequestMetadata,
      });
      yield { type: "text-delta", textDelta: "ok" };
      yield {
        type: "done",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  } satisfies Partial<ModelProviderAdapter>;
  const preset: PresetConfig = {
    id: "slot-story",
    name: "Story",
    provider: "fixture",
    model: "configured-model",
    tier: "medium",
    enabled: true,
    supportedModes: ["text", "stream"],
    capability: { contextWindow: 65_536, maxOutputTokens: 32_768 },
    providerRequestMetadata: {
      privateFlag: "do-not-expose",
      parameterOverrides: {
        maxOutputTokens: 4096,
        temperature: 0.2,
        apiKey: "do-not-expose",
      },
    },
  };
  const config = { providers: {}, profiles: [], presets: [preset] };
  const providerRegistry = createProviderRegistry({
    providers: {
      fixture: {
        adapter,
        defaults: {
          baseUrl: "https://fixture.invalid",
          protocol: "openai-chat-v1",
        },
      },
    },
  });
  const presetRegistry = createPresetRegistry(config);
  const slotRegistry = createSlotRegistry({ presetRegistry });
  slotRegistry.configure({
    slots: { story: { slotId: "story", presetId: preset.id, tag: "text" } },
  });
  const gateway = createGateway({
    providerRegistry,
    presetRegistry,
    slotRegistry,
  });
  const app = createMiscApiRoutes(
    {
      config,
      providerRegistry,
      presetRegistry,
      slotRegistry,
      gateway,
      llmConfig: null,
      modelDb: null,
    },
    createPluginRegistry(),
    createMemoryStore(),
  );
  return { app, requests };
}

afterEach(() => vi.unstubAllEnvs());

describe("LLM settings and connectivity", () => {
  it("publishes explicit limits and recognized parameter defaults without private metadata", async () => {
    const { app } = setup();
    const presets = await (await app.request("/api/presets")).json();
    const config = await (await app.request("/api/llm-config")).json();
    for (const item of [presets.items[0], config.slots.story]) {
      expect(item.capability).toMatchObject({
        contextWindow: 65_536,
        maxOutputTokens: 32_768,
      });
      expect(item.parameterOverrides).toEqual({
        maxOutputTokens: 4096,
        temperature: 0.2,
      });
      expect(JSON.stringify(item)).not.toContain("do-not-expose");
    }
  });

  it("pings the selected role with its own model, output and capability overrides", async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "self");
    const { app, requests } = setup();
    const slotConfig = {
      slotPresetOverrides: { story: "custom-model" },
      customPresets: [
        {
          id: "custom-model",
          provider: "fixture",
          model: "selected-model",
          baseUrl: "https://fixture.invalid",
          protocol: "openai-chat-v1",
        },
      ],
      parameterOverrides: {
        story: { maxOutputTokens: 12_000, temperature: 0.3 },
      },
      capabilityOverrides: {
        story: { contextWindow: 65_536, maxOutputTokens: 8192 },
      },
    };
    const response = await app.request("/api/ai/ping", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Slot-Config": Buffer.from(JSON.stringify(slotConfig)).toString(
          "base64",
        ),
      },
      body: JSON.stringify({ slot: "story" }),
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      testedTarget: { model: "selected-model", resolvedVia: "slot" },
    });
    expect(requests).toEqual([
      {
        model: "selected-model",
        metadata: {
          parameterOverrides: { maxOutputTokens: 8192, temperature: 0.3 },
        },
      },
    ]);
  });
});
