import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createModelGateway,
  createModelProfileRegistry,
  createProviderRegistry,
  ModelGatewayError,
  type EmbeddingResult,
  type ImageGenerationParams,
  type ModelProviderAdapter,
  type ModelRequestContext,
  type ModelProfile,
  type ObjectGenerationParams,
  type PresetMetadata,
  type ProviderConfig,
  type SpeechSynthesisParams,
  type StreamEvent,
  type TextGenerationParams,
  type TranscriptionParams
} from "../src/index.js";

const runtimeProfiles: ModelProfile[] = [
  {
    id: "small",
    tier: "small",
    provider: "openaiCompatible",
    model: "small-model",
    contextWindow: 32_000,
    latencyClass: "low",
    costClass: "low",
    supportedModes: ["text", "object", "stream"]
  },
  {
    id: "medium",
    tier: "medium",
    provider: "openaiCompatible",
    model: "medium-model",
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
];

const primaryPreset: PresetMetadata = {
  id: "default-story",
  name: "Default story",
  provider: "openaiCompatible",
  model: "primary-model",
  tier: "medium",
  baseUrl: "https://primary.example/v1",
  supportedModes: ["text", "object", "stream"],
  enabled: true,
  isDefault: true,
  scope: "global",
  fallbackPresetIds: ["openrouter-free"]
};

const backupPreset: PresetMetadata = {
  id: "openrouter-free",
  name: "OpenRouter free fallback",
  provider: "openrouter",
  model: "openrouter/free-model",
  tier: "small",
  baseUrl: "https://openrouter.example/v1",
  supportedModes: ["text", "object", "stream"],
  enabled: true,
  isDefault: false,
  scope: "global"
};

class FailingPrimaryAdapter implements ModelProviderAdapter {
  public readonly textCalls: string[] = [];
  public readonly objectCalls: string[] = [];
  public readonly streamCalls: string[] = [];

  async generateText(
    _config: ProviderConfig,
    params: TextGenerationParams,
    _context: ModelRequestContext
  ): Promise<{ text: string; finishReason: string; usage: { inputTokens: number; outputTokens: number } }> {
    this.textCalls.push(params.model);
    throw new ModelGatewayError({
      code: "PROVIDER_ERROR",
      message: "primary text failed",
      provider: "openaiCompatible",
      retriable: false,
      statusCode: 503
    });
  }

  async generateObject(
    _config: ProviderConfig,
    params: ObjectGenerationParams<Record<string, unknown>>,
    _context: ModelRequestContext
  ): Promise<{ object: Record<string, unknown>; finishReason: string; usage: { inputTokens: number; outputTokens: number } }> {
    this.objectCalls.push(params.model);
    throw new ModelGatewayError({
      code: "SCHEMA_VALIDATION_FAILED",
      message: "primary object failed",
      provider: "openaiCompatible",
      retriable: false
    });
  }

  async *streamText(
    _config: ProviderConfig,
    params: TextGenerationParams,
    _context: ModelRequestContext
  ): AsyncIterable<StreamEvent> {
    this.streamCalls.push(params.model);
    throw new ModelGatewayError({
      code: "PROVIDER_ERROR",
      message: "primary stream failed",
      provider: "openaiCompatible",
      retriable: false,
      statusCode: 502
    });
  }

  async embed(_config: ProviderConfig, _params: { values: string[] }, _context: ModelRequestContext): Promise<EmbeddingResult> {
    return {
      embeddings: [[0, 1, 0]],
      usage: { inputTokens: 1, outputTokens: 0 }
    };
  }

  async generateImage(
    _config: ProviderConfig,
    _params: ImageGenerationParams,
    _context: ModelRequestContext
  ): Promise<never> {
    throw new ModelGatewayError({
      code: "PROVIDER_ERROR",
      message: "primary image failed",
      provider: "openaiCompatible",
      retriable: false
    });
  }

  async synthesizeSpeech(
    _config: ProviderConfig,
    _params: SpeechSynthesisParams,
    _context: ModelRequestContext
  ): Promise<never> {
    throw new ModelGatewayError({
      code: "PROVIDER_ERROR",
      message: "primary speech failed",
      provider: "openaiCompatible",
      retriable: false
    });
  }

  async transcribeAudio(
    _config: ProviderConfig,
    _params: TranscriptionParams,
    _context: ModelRequestContext
  ): Promise<never> {
    throw new ModelGatewayError({
      code: "PROVIDER_ERROR",
      message: "primary transcription failed",
      provider: "openaiCompatible",
      retriable: false
    });
  }
}

class BackupAdapter implements ModelProviderAdapter {
  public readonly textCalls: string[] = [];
  public readonly objectCalls: string[] = [];
  public readonly streamCalls: string[] = [];

  async generateText(
    _config: ProviderConfig,
    params: TextGenerationParams,
    _context: ModelRequestContext
  ) {
    this.textCalls.push(params.model);
    return {
      text: "fallback text",
      finishReason: "stop" as const,
      usage: { inputTokens: 2, outputTokens: 3 }
    };
  }

  async generateObject(
    _config: ProviderConfig,
    params: ObjectGenerationParams<Record<string, unknown>>,
    _context: ModelRequestContext
  ) {
    this.objectCalls.push(params.model);
    return {
      object: params.schema.parse({
        title: "Fallback scene",
        mood: "tense"
      }),
      finishReason: "stop" as const,
      usage: { inputTokens: 2, outputTokens: 2 }
    };
  }

  async *streamText(
    _config: ProviderConfig,
    params: TextGenerationParams,
    _context: ModelRequestContext
  ): AsyncIterable<StreamEvent> {
    this.streamCalls.push(params.model);
    yield {
      type: "text-delta",
      textDelta: "fallback "
    };
    yield {
      type: "done",
      finishReason: "stop",
      usage: { inputTokens: 2, outputTokens: 1 }
    };
  }

  async embed(_config: ProviderConfig, _params: { values: string[] }, _context: ModelRequestContext): Promise<EmbeddingResult> {
    return {
      embeddings: [[1, 0, 0]],
      usage: { inputTokens: 1, outputTokens: 0 }
    };
  }

  async generateImage(_config: ProviderConfig, _params: ImageGenerationParams, _context: ModelRequestContext) {
    return {
      images: [],
      usage: null
    };
  }

  async synthesizeSpeech(_config: ProviderConfig, _params: SpeechSynthesisParams, _context: ModelRequestContext) {
    return {
      audio: {
        mimeType: "audio/mpeg",
        data: new Uint8Array()
      },
      usage: null
    };
  }

  async transcribeAudio(_config: ProviderConfig, _params: TranscriptionParams, _context: ModelRequestContext) {
    return {
      text: "",
      usage: null
    };
  }
}

function createGateway() {
  const primaryAdapter = new FailingPrimaryAdapter();
  const backupAdapter = new BackupAdapter();

  const providerRegistry = createProviderRegistry({
    providers: {
      openaiCompatible: {
        adapter: primaryAdapter,
        defaults: {
          apiKey: "primary-key",
          baseUrl: "https://primary.example/v1"
        }
      },
      openrouter: {
        adapter: backupAdapter,
        defaults: {
          apiKey: "backup-key",
          baseUrl: "https://openrouter.example/v1"
        }
      }
    }
  });

  const profileRegistry = createModelProfileRegistry({
    runtimeProfiles,
    runtimePresets: [primaryPreset, backupPreset]
  });

  return {
    gateway: createModelGateway({
      providerRegistry,
      profileRegistry
    }),
    primaryAdapter,
    backupAdapter
  };
}

describe("model gateway fallback routing", () => {
  it("falls back to the backup preset for text generation", async () => {
    const { gateway, primaryAdapter, backupAdapter } = createGateway();

    const result = await gateway.generateText({
      presetId: "default-story",
      messages: [
        {
          role: "user",
          content: "Describe the fallback."
        }
      ]
    });

    expect(result.text).toBe("fallback text");
    expect(primaryAdapter.textCalls).toEqual(["primary-model"]);
    expect(backupAdapter.textCalls).toEqual(["openrouter/free-model"]);
  });

  it("falls back to the backup preset for structured output", async () => {
    const { gateway, primaryAdapter, backupAdapter } = createGateway();

    const result = await gateway.generateObject({
      presetId: "default-story",
      schema: z.object({
        title: z.string(),
        mood: z.string()
      }),
      messages: [
        {
          role: "user",
          content: "Return a title and mood."
        }
      ]
    });

    expect(result.object).toEqual({
      title: "Fallback scene",
      mood: "tense"
    });
    expect(primaryAdapter.objectCalls).toEqual(["primary-model"]);
    expect(backupAdapter.objectCalls).toEqual(["openrouter/free-model"]);
  });

  it("falls back to the backup preset for streaming before any delta is emitted", async () => {
    const { gateway, primaryAdapter, backupAdapter } = createGateway();
    const events: StreamEvent[] = [];

    for await (const event of gateway.streamText({
      presetId: "default-story",
      messages: [
        {
          role: "user",
          content: "Stream the backup path."
        }
      ]
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "text-delta",
        textDelta: "fallback "
      },
      {
        type: "done",
        finishReason: "stop",
        usage: {
          inputTokens: 2,
          outputTokens: 1
        }
      }
    ]);
    expect(primaryAdapter.streamCalls).toEqual(["primary-model"]);
    expect(backupAdapter.streamCalls).toEqual(["openrouter/free-model"]);
  });
});
