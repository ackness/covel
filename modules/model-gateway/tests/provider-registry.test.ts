import { describe, expect, it } from "vitest";

import {
  createProviderRegistry,
  createModelGateway,
  createModelProfileRegistry,
  type EmbeddingResult,
  type ImageGenerationParams,
  type ImageGenerationResult,
  type ModelProviderAdapter,
  type ModelRequestContext,
  type ObjectGenerationParams,
  type PresetMetadata,
  type ProviderLifecycleHook,
  type ProviderProtocol,
  type ProviderConfig,
  type SpeechSynthesisParams,
  type SpeechSynthesisResult,
  type StreamEvent,
  type TextGenerationParams,
  type TranscriptionParams,
  type TranscriptionResult
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

  async generateImage(
    _config: ProviderConfig,
    _params: ImageGenerationParams,
    _context: ModelRequestContext
  ): Promise<ImageGenerationResult> {
    return {
      images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
      usage: { inputTokens: 1, outputTokens: 1 }
    };
  }

  async synthesizeSpeech(
    _config: ProviderConfig,
    _params: SpeechSynthesisParams,
    _context: ModelRequestContext
  ): Promise<SpeechSynthesisResult> {
    return {
      audio: {
        mimeType: "audio/mpeg",
        data: Buffer.from("speech")
      },
      usage: { inputTokens: 1, outputTokens: 1 }
    };
  }

  async transcribeAudio(
    _config: ProviderConfig,
    _params: TranscriptionParams,
    _context: ModelRequestContext
  ): Promise<TranscriptionResult> {
    return {
      text: "transcribed",
      usage: { inputTokens: 1, outputTokens: 1 }
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
      protocol: "openai-chat-v1",
      model: "gpt-medium",
      tier: "medium",
      baseUrl: "https://preset.example/v1",
      supportedModes: ["text", "object", "stream"],
      enabled: true,
      isDefault: true,
      scope: "global"
    };

    const resolved = registry.resolve(preset, {
      mode: "text"
    });

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
        protocol: "openai-chat-v1",
        model: "gpt-missing",
        tier: "small",
        supportedModes: ["text"],
        enabled: true,
        isDefault: false,
        scope: "global"
      }, {
        mode: "text"
      })
    ).toThrowError("Provider registry error: provider \"unknown\" is not registered.");
  });

  it("resolves protocol-specific adapters and route defaults", () => {
    const chatAdapter = new StubProviderAdapter();
    const responsesAdapter = new StubProviderAdapter();
    const registry = createProviderRegistry({
      providers: {
        openaiCompatible: {
          defaults: {
            baseUrl: "https://runtime.example/v1",
            apiKey: "runtime-key"
          },
          protocols: {
            "openai-chat-v1": {
              adapter: chatAdapter
            },
            "openai-responses-v1": {
              adapter: responsesAdapter,
              defaults: {
                baseUrl: "https://responses.example/v1"
              }
            }
          }
        }
      }
    });

    const resolved = registry.resolve({
      id: "preset-responses",
      name: "Responses preset",
      provider: "openaiCompatible",
      protocol: "openai-responses-v1",
      model: "gpt-responses",
      tier: "medium",
      supportedModes: ["text", "object", "stream"],
      enabled: true,
      isDefault: false,
      scope: "global"
    }, {
      mode: "text"
    });

    expect(resolved.adapter).toBe(responsesAdapter);
    expect(resolved.protocol).toBe("openai-responses-v1");
    expect(resolved.config).toMatchObject({
      baseUrl: "https://responses.example/v1",
      apiKey: "runtime-key"
    });
  });

  it("exposes provider lifecycle hooks on the resolved route", () => {
    const hook: ProviderLifecycleHook = {
      onRequestStart() {},
      onRequestSuccess() {},
      onRequestError() {}
    };
    const registry = createProviderRegistry({
      providers: {
        anthropic: {
          defaults: {
            baseUrl: "https://api.anthropic.test/v1",
            apiKey: "anthropic-key"
          },
          hooks: [hook],
          protocols: {
            "anthropic-messages-v1": {
              adapter: new StubProviderAdapter()
            }
          }
        }
      }
    });

    const resolved = registry.resolve({
      id: "claude-default",
      name: "Claude default",
      provider: "anthropic",
      protocol: "anthropic-messages-v1",
      model: "claude-sonnet",
      tier: "medium",
      supportedModes: ["text", "object", "stream"],
      enabled: true,
      isDefault: true,
      scope: "global"
    }, {
      mode: "text"
    });

    expect(resolved.protocol).toBe("anthropic-messages-v1");
    expect(resolved.hooks).toEqual([hook]);
  });

  it("resolves multimodal routes using the requested mode", () => {
    const adapter = new StubProviderAdapter();
    const registry = createProviderRegistry({
      providers: {
        openaiCompatible: {
          adapter,
          defaults: {
            baseUrl: "https://runtime.example/v1",
            apiKey: "runtime-key"
          }
        }
      }
    });

    const resolved = registry.resolve({
      id: "story-media",
      name: "Story media",
      provider: "openaiCompatible",
      model: "media-model",
      tier: "medium",
      supportedModes: ["image", "speech", "transcription"],
      enabled: true,
      isDefault: false,
      scope: "global"
    }, {
      mode: "image"
    });

    expect(resolved.adapter).toBe(adapter);
    expect(resolved.protocol).toBe("openai-chat-v1");
  });

  it("allows hooks to observe request lifecycle through the model gateway", async () => {
    const events: string[] = [];
    const adapter = new StubProviderAdapter();
    const registry = createProviderRegistry({
      providers: {
        openaiCompatible: {
          defaults: {
            baseUrl: "https://runtime.example/v1",
            apiKey: "runtime-key"
          },
          hooks: [
            {
              onRequestStart(event) {
                events.push(`start:${event.protocol}:${event.mode}:${event.model}`);
              },
              onRequestSuccess(event) {
                events.push(`success:${event.protocol}:${event.mode}:${event.usage?.outputTokens ?? 0}`);
              }
            }
          ],
          protocols: {
            "openai-chat-v1": {
              adapter
            }
          }
        }
      }
    });
    const gateway = createModelGateway({
      providerRegistry: registry,
      profileRegistry: createModelProfileRegistry({
        runtimeProfiles: [
          {
            id: "medium",
            tier: "medium",
            provider: "openaiCompatible",
            model: "qwen-medium",
            contextWindow: 64_000,
            latencyClass: "medium",
            costClass: "medium",
            supportedModes: ["text", "object", "stream"]
          },
          {
            id: "embed-default",
            tier: "embed-default",
            provider: "openaiCompatible",
            model: "embed-model",
            contextWindow: 8_000,
            latencyClass: "low",
            costClass: "low",
            supportedModes: ["embed"]
          }
        ],
        runtimePresets: [
          {
            id: "default-medium",
            name: "Default medium",
            provider: "openaiCompatible",
            protocol: "openai-chat-v1",
            model: "qwen-medium",
            tier: "medium",
            baseUrl: "https://runtime.example/v1",
            supportedModes: ["text", "object", "stream"],
            enabled: true,
            isDefault: true,
            scope: "global"
          }
        ]
      })
    });

    await gateway.generateText({
      presetId: "default-medium",
      messages: [
        {
          role: "user",
          content: "Say hello."
        }
      ]
    });

    expect(events).toEqual([
      "start:openai-chat-v1:text:qwen-medium",
      "success:openai-chat-v1:text:1"
    ]);
  });
});
