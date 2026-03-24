import { describe, expect, it } from "vitest";

import {
  createProviderRegistry,
  type EmbeddingResult,
  type ModelProviderAdapter,
  type ModelRequestContext,
  type ObjectGenerationParams,
  type PresetMetadata,
  type ProviderConfig,
  type StreamEvent,
  type TextGenerationParams
} from "../src/index.js";

class StubProviderAdapter implements ModelProviderAdapter {
  async generateText(_config: ProviderConfig, _params: TextGenerationParams, _context: ModelRequestContext) {
    return {
      text: "ok",
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1 }
    };
  }

  async generateObject(
    _config: ProviderConfig,
    _params: ObjectGenerationParams<Record<string, unknown>>,
    _context: ModelRequestContext
  ) {
    return {
      object: { ok: true },
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1 }
    };
  }

  async *streamText(
    _config: ProviderConfig,
    _params: TextGenerationParams,
    _context: ModelRequestContext
  ): AsyncIterable<StreamEvent> {
    yield { type: "text-delta", textDelta: "ok" };
    yield {
      type: "done",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 }
    };
  }

  async embed(
    _config: ProviderConfig,
    _params: { values: string[] },
    _context: ModelRequestContext
  ): Promise<EmbeddingResult> {
    return {
      embeddings: [[1, 0, 0]],
      usage: { inputTokens: 1, outputTokens: 0 }
    };
  }
}

describe("ProviderRegistry", () => {
  it("registers adapters and resolves provider config by preset metadata", () => {
    const adapter = new StubProviderAdapter();
    const registry = createProviderRegistry({
      providers: {
        openaiCompatible: {
          adapter,
          defaults: {
            baseUrl: "https://runtime.example/v1",
            apiKey: "runtime-key",
            headers: {
              "x-runtime-header": "runtime"
            }
          }
        }
      }
    });

    const preset: PresetMetadata = {
      id: "preset-medium",
      name: "Default medium",
      provider: "openaiCompatible",
      model: "gpt-medium",
      tier: "medium",
      baseUrl: "https://preset.example/v1",
      supportedModes: ["text", "object", "stream"],
      enabled: true,
      isDefault: true,
      scope: "global"
    };

    const resolved = registry.resolve(preset);

    expect(resolved.adapter).toBe(adapter);
    expect(resolved.config).toEqual({
      baseUrl: "https://preset.example/v1",
      apiKey: "runtime-key",
      headers: {
        "x-runtime-header": "runtime"
      }
    });
  });

  it("throws when resolving an unknown provider", () => {
    const registry = createProviderRegistry();

    expect(() =>
      registry.resolve({
        id: "missing",
        name: "Missing",
        provider: "unknown",
        model: "gpt-missing",
        tier: "small",
        supportedModes: ["text"],
        enabled: true,
        isDefault: false,
        scope: "global"
      })
    ).toThrowError("Provider registry error: provider \"unknown\" is not registered.");
  });
});
