/**
 * Phase 1 embedding path tests.
 *
 * Covers the full chain for gateway.embed():
 *  - llm.toml → convertToAiConfig emits a synthetic "embed-default" profile
 *    when a slot declares output = ["embedding"]
 *  - preset-registry.resolveEmbeddingTarget() returns both profile + preset
 *  - gateway.embed() routes through the embed profile's provider (not the
 *    text target's)
 *  - openai-chat.ts embed() dispatches on providerRequestMetadata.embeddingFormat
 *    to produce either standard `{input: string[]}` or the Nemotron
 *    `{input: [{content: [...]}]}` shape
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { parseLlmConfig } from "../src/config/llm-loader.js";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";

// ── llm-loader: embed profile synthesis ─────────────────────────

describe("llm-loader: embed-default profile synthesis", () => {
  it("emits an embed-default profile when a slot has output = [embedding]", () => {
    const { aiConfig } = parseLlmConfig(`
[covel.story]
provider = "deepseek"
model    = "deepseek-chat"
baseUrl  = "https://api.deepseek.com"
protocol = "openai-chat-v1"

[covel.embed-default]
provider = "ollama"
model    = "nomic-embed-text-v2-moe"
baseUrl  = "http://localhost:11434/v1"
protocol = "openai-chat-v1"
output   = ["embedding"]
`);

    const embedProfile = aiConfig.profiles.find((p) => p.id === "embed-default");
    expect(embedProfile).toBeDefined();
    expect(embedProfile?.provider).toBe("ollama");
    expect(embedProfile?.model).toBe("nomic-embed-text-v2-moe");
    expect(embedProfile?.tier).toBe("embed-default");
    expect(embedProfile?.supportedModes).toEqual(["embed"]);

    const embedPreset = aiConfig.presets.find((p) =>
      p.supportedModes.includes("embed"),
    );
    expect(embedPreset?.provider).toBe("ollama");
    expect(embedPreset?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("does not emit an embed profile when no slot declares embedding output", () => {
    const { aiConfig } = parseLlmConfig(`
[covel.story]
provider = "deepseek"
model    = "deepseek-chat"
baseUrl  = "https://api.deepseek.com"
protocol = "openai-chat-v1"
`);
    expect(aiConfig.profiles.find((p) => p.id === "embed-default")).toBeUndefined();
  });

  it("first embed slot wins when multiple are declared", () => {
    const { aiConfig } = parseLlmConfig(`
[covel.embed-default]
provider = "ollama"
model    = "nomic-embed-text-v2-moe"
baseUrl  = "http://localhost:11434/v1"
protocol = "openai-chat-v1"
output   = ["embedding"]

[covel.embed-multimodal]
provider = "openrouter"
model    = "nvidia/llama-nemotron-embed-vl-1b-v2:free"
baseUrl  = "https://openrouter.ai/api/v1"
protocol = "openai-chat-v1"
output   = ["embedding"]
embeddingFormat = "nemotron-multimodal"
`);

    const embedProfiles = aiConfig.profiles.filter((p) => p.id === "embed-default");
    expect(embedProfiles).toHaveLength(1);
    expect(embedProfiles[0].provider).toBe("ollama");

    const nemotronPreset = aiConfig.presets.find((p) => p.id === "slot-embed-multimodal");
    expect(nemotronPreset?.embeddingFormat).toBe("nemotron-multimodal");
  });
});

// ── openai-chat.embed(): format dispatch ───────────────────────

describe("openai-chat adapter: embed format dispatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockEmbeddingResponse(dim = 768, count = 1) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            data: Array.from({ length: count }, (_, i) => ({
              embedding: Array(dim).fill(0.1),
              index: i,
            })),
            usage: { prompt_tokens: 42, total_tokens: 42 },
          }),
      }),
    );
  }

  it('sends {input: string[]} by default (openai format)', async () => {
    mockEmbeddingResponse(768, 2);
    const adapter = createOpenAiChatAdapter();
    await adapter.embed(
      { baseUrl: "http://localhost:11434/v1", apiKey: "test" },
      { model: "nomic-embed-text-v2-moe", values: ["hello", "world"] },
    );
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.input).toEqual(["hello", "world"]);
    expect(body.model).toBe("nomic-embed-text-v2-moe");
  });

  it('wraps values in content arrays when embeddingFormat = nemotron-multimodal', async () => {
    mockEmbeddingResponse(2048, 1);
    const adapter = createOpenAiChatAdapter();
    await adapter.embed(
      { baseUrl: "https://openrouter.ai/api/v1", apiKey: "test" },
      {
        model: "nvidia/llama-nemotron-embed-vl-1b-v2:free",
        values: ["a cat"],
        providerRequestMetadata: { embeddingFormat: "nemotron-multimodal" },
      },
    );
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.input).toEqual([{ content: [{ type: "text", text: "a cat" }] }]);
    // embeddingFormat must not leak into the request body
    expect(body.embeddingFormat).toBeUndefined();
  });

  it("returns mapped embeddings + usage in both formats", async () => {
    mockEmbeddingResponse(768, 3);
    const adapter = createOpenAiChatAdapter();
    const result = await adapter.embed(
      { baseUrl: "http://localhost:11434/v1", apiKey: "test" },
      { model: "nomic-embed-text-v2-moe", values: ["a", "b", "c"] },
    );
    expect(result.embeddings).toHaveLength(3);
    expect(result.embeddings[0]).toHaveLength(768);
    expect(result.usage.inputTokens).toBe(42);
  });
});

// ── gateway.embed(): end-to-end with stub adapter ─────────────

describe("gateway.embed: routes through embed-default profile", () => {
  it("uses the embed profile's provider without requiring a text slot", async () => {
    const embedAdapter = vi.fn().mockResolvedValue({
      embeddings: [[0.1, 0.2]],
      usage: { inputTokens: 5, outputTokens: 0 },
    });

    const providerRegistry = createProviderRegistry({
      providers: {
        ollama: {
          adapter: {
            // Only embed is called in this test; stub the rest for type compliance.
            generateText: vi.fn(),
            generateObject: vi.fn(),
            // eslint-disable-next-line require-yield
            async *streamText() {
              throw new Error("unused");
            },
            embed: embedAdapter,
            generateImage: vi.fn(),
            synthesizeSpeech: vi.fn(),
            transcribeAudio: vi.fn(),
          } as never,
          defaults: { baseUrl: "http://localhost:11434/v1" },
        },
      },
    });

    const presetRegistry = createPresetRegistry({
      profiles: [
        {
          id: "embed-default",
          tier: "embed-default",
          provider: "ollama",
          model: "nomic-embed-text-v2-moe",
          contextWindow: 8192,
          latencyClass: "medium",
          costClass: "medium",
          supportedModes: ["embed"],
        },
      ],
      presets: [],
    });

    const gateway = createGateway({ providerRegistry, presetRegistry });
    const result = await gateway.embed({ values: ["hello"] });

    expect(result.embeddings).toEqual([[0.1, 0.2]]);
    expect(embedAdapter).toHaveBeenCalledOnce();
    const [, params] = embedAdapter.mock.calls[0];
    expect(params.model).toBe("nomic-embed-text-v2-moe");
    expect(params.values).toEqual(["hello"]);
  });

  it("merges slot-level embeddingFormat into providerRequestMetadata", async () => {
    const embedAdapter = vi.fn().mockResolvedValue({
      embeddings: [[0.1]],
      usage: { inputTokens: 1, outputTokens: 0 },
    });

    const providerRegistry = createProviderRegistry({
      providers: {
        openrouter: {
          adapter: {
            generateText: vi.fn(),
            generateObject: vi.fn(),
            async *streamText() {
              throw new Error("unused");
            },
            embed: embedAdapter,
            generateImage: vi.fn(),
            synthesizeSpeech: vi.fn(),
            transcribeAudio: vi.fn(),
          } as never,
          defaults: { baseUrl: "https://openrouter.ai/api/v1" },
        },
      },
    });

    const presetRegistry = createPresetRegistry({
      profiles: [
        {
          id: "embed-default",
          tier: "embed-default",
          provider: "openrouter",
          model: "nvidia/llama-nemotron-embed-vl-1b-v2:free",
          contextWindow: 8192,
          latencyClass: "medium",
          costClass: "medium",
          supportedModes: ["embed"],
        },
      ],
      presets: [
        {
          id: "slot-embed-multimodal",
          name: "Nemotron",
          provider: "openrouter",
          protocol: "openai-chat-v1",
          model: "nvidia/llama-nemotron-embed-vl-1b-v2:free",
          tier: "medium",
          supportedModes: ["embed"],
          enabled: true,
          embeddingFormat: "nemotron-multimodal",
        },
      ],
    });

    const gateway = createGateway({ providerRegistry, presetRegistry });
    await gateway.embed({ values: ["a cat"] });

    const [, params] = embedAdapter.mock.calls[0];
    expect(params.providerRequestMetadata?.embeddingFormat).toBe(
      "nemotron-multimodal",
    );
  });
});
