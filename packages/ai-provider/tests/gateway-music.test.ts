import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import { getMusicWire, registerMusicWire } from "../src/music/wire-registry.js";
import type { MusicWire } from "../src/music/types.js";
import type { ModelProfile, PresetConfig } from "../src/types.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";

// Unused by music — the wire bypasses the adapter — but resolving a provider
// still requires one to be registered.
function createStubAdapter(): ModelProviderAdapter {
  return {
    async generateText() {
      return {
        text: "stub",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    async generateObject<TObject>() {
      return {
        object: {} as TObject,
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    async *streamText() {},
    async embed() {
      return { embeddings: [[]], usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

const profiles: ModelProfile[] = [
  {
    id: "medium",
    tier: "medium",
    provider: "test",
    model: "test-music-model",
    contextWindow: 1,
    latencyClass: "slow",
    costClass: "high",
    supportedModes: ["music", "speech"],
  },
];

function setup(presets: PresetConfig[]) {
  const providerRegistry = createProviderRegistry({
    providers: {
      test: {
        adapter: createStubAdapter(),
        defaults: { baseUrl: "https://x.test", apiKey: "k" },
      },
    },
  });
  return createGateway({
    providerRegistry,
    presetRegistry: createPresetRegistry({ profiles, presets }),
  });
}

const musicPreset = (overrides: Partial<PresetConfig> = {}): PresetConfig => ({
  id: "music",
  name: "Music",
  provider: "test",
  model: "test-music-model",
  tier: "medium",
  supportedModes: ["music"],
  enabled: true,
  ...overrides,
});

const disposers: (() => void)[] = [];
function register(wire: MusicWire): MusicWire {
  disposers.push(registerMusicWire(wire));
  return wire;
}
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("music wire registry", () => {
  it("has no built-in wire, registers one, and rejects a duplicate id", () => {
    expect(getMusicWire("test-music")).toBeNull();
    const wire = register({
      id: "test-music",
      compose: async () => ({
        audio: { mimeType: "audio/mpeg", data: new Uint8Array() },
        usage: null,
        warnings: [],
      }),
    });
    expect(getMusicWire("test-music")).toBe(wire);
    expect(() => registerMusicWire(wire)).toThrow(/already registered/);
  });
});

describe("gateway.composeMusic", () => {
  it("sends the request and the slot's settings to the wire the slot names", async () => {
    const compose = vi.fn<MusicWire["compose"]>(async () => ({
      audio: { mimeType: "audio/mpeg", data: new Uint8Array([1, 2, 3]) },
      usage: null,
      warnings: ["got 30 s"],
    }));
    register({ id: "studio/v1", compose });
    const gateway = setup([
      musicPreset({
        providerRequestMetadata: { musicWire: "studio/v1", style: "folk" },
      }),
    ]);

    const result = await gateway.composeMusic({
      prompt: "slow strings, a tavern at night",
      instrumental: true,
      durationSeconds: 45,
      providerRequestMetadata: { style: "chamber" },
    });

    expect(result).toMatchObject({
      audio: { mimeType: "audio/mpeg" },
      warnings: ["got 30 s"],
      model: "test-music-model",
      provider: "test",
    });
    expect(compose.mock.calls[0]![1]).toEqual({
      model: "test-music-model",
      prompt: "slow strings, a tavern at night",
      instrumental: true,
      durationSeconds: 45,
      // A call's own settings win over the slot's.
      providerRequestMetadata: { musicWire: "studio/v1", style: "chamber" },
    });
    expect(compose.mock.calls[0]![2]).toMatchObject({ mode: "music" });
  });

  it("fails before any request when the slot names no wire, or an unknown one", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(
        setup([musicPreset()]).composeMusic({ prompt: "x" }),
      ).rejects.toMatchObject({
        code: "CONFIG_ERROR",
        retriable: false,
        message: expect.stringContaining("no music wire configured"),
      });
      await expect(
        setup([
          musicPreset({ providerRequestMetadata: { musicWire: "absent" } }),
        ]).composeMusic({ prompt: "x" }),
      ).rejects.toMatchObject({
        code: "CONFIG_ERROR",
        message: expect.stringContaining('unknown music wire "absent"'),
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never falls back to a text or a speech slot", async () => {
    const compose = vi.fn<MusicWire["compose"]>();
    register({ id: "studio/v1", compose });
    const gateway = setup([
      {
        id: "story",
        name: "Story",
        provider: "test",
        model: "test-text-model",
        tier: "medium",
        supportedModes: ["text"],
        enabled: true,
        isDefault: true,
      },
      {
        id: "speech",
        name: "Speech",
        provider: "test",
        model: "test-tts-model",
        tier: "medium",
        supportedModes: ["speech"],
        enabled: true,
        providerRequestMetadata: { musicWire: "studio/v1" },
      },
    ]);

    await expect(gateway.composeMusic({ prompt: "x" })).rejects.toThrow(
      /music/,
    );
    expect(compose).not.toHaveBeenCalled();
  });
});
