import { describe, expect, it } from "vitest";

import {
  createModelGateway,
  createModelProfileRegistry,
  createProviderRegistry,
  type EmbeddingResult,
  type ImageGenerationParams,
  type ImageGenerationResult,
  type ModelProfile,
  type ModelProviderAdapter,
  type ModelRequestContext,
  type ObjectGenerationParams,
  type PresetMetadata,
  type ProviderConfig,
  type SpeechSynthesisParams,
  type SpeechSynthesisResult,
  type StreamEvent,
  type TextGenerationParams,
  type TranscriptionParams,
  type TranscriptionResult
} from "../src/index.js";

class MultimodalStubAdapter implements ModelProviderAdapter {
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
    params: ImageGenerationParams,
    _context: ModelRequestContext
  ): Promise<ImageGenerationResult> {
    return {
      images: [
        {
          mimeType: "image/png",
          dataBase64: Buffer.from(`image:${params.prompt}`).toString("base64")
        }
      ],
      usage: { inputTokens: 3, outputTokens: 1 }
    };
  }

  async synthesizeSpeech(
    _config: ProviderConfig,
    params: SpeechSynthesisParams,
    _context: ModelRequestContext
  ): Promise<SpeechSynthesisResult> {
    return {
      audio: {
        mimeType: params.format ?? "audio/mpeg",
        data: Buffer.from(`speech:${params.text}`)
      },
      usage: { inputTokens: 2, outputTokens: 1 }
    };
  }

  async transcribeAudio(
    _config: ProviderConfig,
    params: TranscriptionParams,
    _context: ModelRequestContext
  ): Promise<TranscriptionResult> {
    return {
      text: `transcribed:${params.audio.fileName ?? "audio"}`,
      usage: { inputTokens: 1, outputTokens: 1 }
    };
  }
}

describe("multimodal model gateway foundation", () => {
  const runtimeProfiles = [
    {
      id: "medium",
      tier: "medium" as const,
      provider: "openaiCompatible",
      model: "story-model",
      contextWindow: 64_000,
      latencyClass: "medium",
      costClass: "medium",
      supportedModes: ["text", "object", "stream", "image", "speech", "transcription"] as ModelProfile["supportedModes"]
    },
    {
      id: "embed-default",
      tier: "embed-default" as const,
      provider: "openaiCompatible",
      model: "embed-model",
      contextWindow: 8_000,
      latencyClass: "low",
      costClass: "low",
      supportedModes: ["embed"] as ModelProfile["supportedModes"]
    }
  ];

  const runtimePreset: PresetMetadata = {
    id: "story-default",
    name: "Story default",
    provider: "openaiCompatible",
    model: "preset-story-model",
    tier: "medium",
    baseUrl: "https://runtime.example/v1",
    supportedModes: ["text", "object", "stream", "image", "speech", "transcription"],
    enabled: true,
    isDefault: true,
    scope: "global"
  };

  function createGateway() {
    return createModelGateway({
      providerRegistry: createProviderRegistry({
        providers: {
          openaiCompatible: {
            adapter: new MultimodalStubAdapter(),
            defaults: {
              apiKey: "fixture-key"
            }
          }
        }
      }),
      profileRegistry: createModelProfileRegistry({
        runtimeProfiles,
        runtimePresets: [runtimePreset]
      })
    });
  }

  it("delegates image generation through the selected preset", async () => {
    const gateway = createGateway();

    const result = await gateway.generateImage({
      presetId: "story-default",
      prompt: "foggy harbor"
    });

    expect(result).toEqual({
      images: [
        {
          mimeType: "image/png",
          dataBase64: Buffer.from("image:foggy harbor").toString("base64")
        }
      ],
      usage: { inputTokens: 3, outputTokens: 1 }
    });
  });

  it("delegates speech synthesis through the selected preset", async () => {
    const gateway = createGateway();

    const result = await gateway.synthesizeSpeech({
      presetId: "story-default",
      text: "The harbor wakes.",
      format: "audio/mpeg"
    });

    expect(result.audio.mimeType).toBe("audio/mpeg");
    expect(Buffer.from(result.audio.data).toString("utf8")).toBe("speech:The harbor wakes.");
  });

  it("delegates transcription through the selected preset", async () => {
    const gateway = createGateway();

    const result = await gateway.transcribeAudio({
      presetId: "story-default",
      audio: {
        data: Buffer.from("wav-bytes"),
        mimeType: "audio/wav",
        fileName: "turn.wav"
      }
    });

    expect(result).toEqual({
      text: "transcribed:turn.wav",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  });
});
