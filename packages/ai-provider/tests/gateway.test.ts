import { describe, it, expect, vi } from "vitest";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import type { ModelProfile, PresetConfig, StreamEvent } from "../src/types.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";

// ── Stub adapter ───────────────────────────────────────────────────

function createStubAdapter(
  overrides: Partial<ModelProviderAdapter> = {}
): ModelProviderAdapter {
  return {
    async generateText() {
      return {
        text: "stub response",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
    async generateObject<TObject>() {
      return {
        object: { result: true } as TObject,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
    async *streamText() {
      yield { type: "text-delta" as const, textDelta: "hello " };
      yield { type: "text-delta" as const, textDelta: "world" };
      yield {
        type: "done" as const,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    async embed() {
      return {
        embeddings: [[0.1, 0.2, 0.3]],
        usage: { inputTokens: 5, outputTokens: 0 },
      };
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
      return { text: "transcribed", usage: null };
    },
    ...overrides,
  };
}

// ── Test fixtures ──────────────────────────────────────────────────

const profiles: ModelProfile[] = [
  {
    id: "medium",
    tier: "medium",
    provider: "test",
    model: "test-model",
    contextWindow: 64000,
    latencyClass: "medium",
    costClass: "low",
    supportedModes: ["text", "object", "stream"],
  },
  {
    id: "embed-default",
    tier: "embed-default",
    provider: "test",
    model: "embed-model",
    contextWindow: 8191,
    latencyClass: "low",
    costClass: "low",
    supportedModes: ["embed"],
  },
];

const presets: PresetConfig[] = [
  {
    id: "primary",
    name: "Primary",
    provider: "test",
    model: "test-model",
    tier: "medium",
    supportedModes: ["text", "object", "stream"],
    enabled: true,
    isDefault: true,
    fallbackPresetIds: ["backup"],
  },
  {
    id: "backup",
    name: "Backup",
    provider: "backup-provider",
    model: "backup-model",
    tier: "medium",
    supportedModes: ["text", "object", "stream"],
    enabled: true,
  },
];

describe("gateway", () => {
  function setup(adapterOverrides?: Partial<ModelProviderAdapter>) {
    const stubAdapter = createStubAdapter(adapterOverrides);

    const providerRegistry = createProviderRegistry({
      providers: {
        test: { adapter: stubAdapter, defaults: { baseUrl: "https://test.api" } },
        "backup-provider": {
          adapter: stubAdapter,
          defaults: { baseUrl: "https://backup.api" },
        },
      },
    });

    const presetRegistry = createPresetRegistry({ profiles, presets });
    const gateway = createGateway({ providerRegistry, presetRegistry });

    return { gateway, stubAdapter };
  }

  it("generateText returns text result", async () => {
    const { gateway } = setup();
    const result = await gateway.generateText({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.text).toBe("stub response");
    expect(result.usage.inputTokens).toBe(10);
  });

  it("streamText yields events", async () => {
    const { gateway } = setup();
    const events: StreamEvent[] = [];

    for await (const event of gateway.streamText({
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "text-delta", textDelta: "hello " });
    expect(events[2]).toMatchObject({ type: "done", finishReason: "stop" });
  });

  it("falls back to backup on primary failure", async () => {
    let callCount = 0;
    const { gateway } = setup({
      async generateText() {
        callCount++;
        if (callCount === 1) {
          throw new Error(
            JSON.stringify({
              name: "AiProviderError",
              code: "PROVIDER_ERROR",
              provider: "test",
              retriable: true,
              statusCode: 500,
            })
          );
        }
        return {
          text: "backup response",
          finishReason: "stop",
          usage: { inputTokens: 5, outputTokens: 10 },
        };
      },
    });

    const result = await gateway.generateText({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(callCount).toBe(2);
    expect(result.text).toBe("backup response");
  });

  it("does not fallback on non-retriable error", async () => {
    let callCount = 0;
    const { gateway } = setup({
      async generateText() {
        callCount++;
        throw new Error(
          JSON.stringify({
            name: "AiProviderError",
            code: "CONFIG_ERROR",
            provider: "test",
            retriable: false,
          })
        );
      },
    });

    await expect(
      gateway.generateText({
        messages: [{ role: "user", content: "hi" }],
      })
    ).rejects.toThrow();

    // Should not attempt fallback since CONFIG_ERROR is not in shouldFallback list
    expect(callCount).toBe(1);
  });
});
