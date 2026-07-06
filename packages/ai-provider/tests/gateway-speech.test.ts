import { describe, it, expect, vi, afterEach } from "vitest";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import {
  registerSpeechWire,
  registerTranscriptionWire,
} from "../src/speech/wire-registry.js";
import type { SpeechWire, TranscriptionWire } from "../src/speech/types.js";
import type { ModelProfile, PresetConfig } from "../src/types.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";

// ── Stub adapter (unused by speech operations — the wire bypasses it — but
// provider-registry.resolve() still requires one to be registered) ────

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
    id: "speech-tier",
    tier: "speech-tier",
    provider: "test",
    model: "test-tts-model",
    contextWindow: 1,
    latencyClass: "medium",
    costClass: "low",
    supportedModes: ["speech", "transcription"],
  },
];

function setup(presetOverrides: Partial<PresetConfig> = {}) {
  const providerRegistry = createProviderRegistry({
    providers: {
      test: {
        adapter: createStubAdapter(),
        defaults: { baseUrl: "https://x.test", apiKey: "k" },
      },
    },
  });
  const presets: PresetConfig[] = [
    {
      id: "tts-primary",
      name: "TTS Primary",
      provider: "test",
      model: "test-tts-model",
      tier: "speech-tier",
      supportedModes: ["speech", "transcription"],
      enabled: true,
      ...presetOverrides,
    },
  ];
  const presetRegistry = createPresetRegistry({ profiles, presets });
  const gateway = createGateway({ providerRegistry, presetRegistry });
  return { gateway };
}

afterEach(() => vi.unstubAllGlobals());

describe("gateway.synthesizeSpeech", () => {
  function mockSpeechFetch() {
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "audio/mpeg" }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      text: async () => "{}",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("dispatches to the default openai-speech wire", async () => {
    const fn = mockSpeechFetch();
    const { gateway } = setup();

    const result = await gateway.synthesizeSpeech({
      presetId: "tts-primary",
      text: "hello",
      voice: "alloy",
    });

    expect(fn).toHaveBeenCalledWith(
      "https://x.test/v1/audio/speech",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.audio.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.model).toBe("test-tts-model");
    expect(result.provider).toBe("test");
  });

  it("dispatches to a custom wire named via preset providerRequestMetadata.speechWire", async () => {
    const customWire: SpeechWire = {
      id: "gateway-test-custom-speech-wire",
      synthesize: async () => ({
        audio: { mimeType: "audio/wav", data: new Uint8Array([7]) },
        usage: null,
        warnings: ["custom wire used"],
      }),
    };
    registerSpeechWire(customWire);

    const { gateway } = setup({
      providerRequestMetadata: {
        speechWire: "gateway-test-custom-speech-wire",
      },
    });

    const result = await gateway.synthesizeSpeech({
      presetId: "tts-primary",
      text: "hello",
    });

    expect(result.audio.mimeType).toBe("audio/wav");
    expect(result.warnings).toEqual(["custom wire used"]);
  });

  it("throws a clear error for an unregistered speechWire id", async () => {
    const { gateway } = setup({
      providerRequestMetadata: { speechWire: "ghost" },
    });

    await expect(
      gateway.synthesizeSpeech({ presetId: "tts-primary", text: "hi" }),
    ).rejects.toThrow(/unknown speech wire "ghost"/);
  });

  it("does not silently route to the default text slot when presetId is omitted", async () => {
    mockSpeechFetch();
    const providerRegistry = createProviderRegistry({
      providers: {
        test: {
          adapter: createStubAdapter(),
          defaults: { baseUrl: "https://x.test", apiKey: "k" },
        },
      },
    });
    const presetRegistry = createPresetRegistry({
      profiles,
      presets: [
        {
          id: "story",
          name: "Story",
          provider: "test",
          model: "test-text-model",
          tier: "speech-tier",
          supportedModes: ["text"],
          enabled: true,
          isDefault: true,
        },
        {
          id: "tts-primary",
          name: "TTS Primary",
          provider: "test",
          model: "test-tts-model",
          tier: "speech-tier",
          supportedModes: ["speech"],
          enabled: true,
        },
      ],
    });
    const gateway = createGateway({ providerRegistry, presetRegistry });

    await expect(gateway.synthesizeSpeech({ text: "hi" })).rejects.toThrow(
      /speech/,
    );
  });
});

describe("gateway.transcribeAudio", () => {
  function mockTranscriptionFetch() {
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ text: "transcribed" }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("dispatches to the default openai-transcription wire", async () => {
    const fn = mockTranscriptionFetch();
    const { gateway } = setup();

    const result = await gateway.transcribeAudio({
      presetId: "tts-primary",
      audio: { data: new Uint8Array([1]), mimeType: "audio/wav" },
    });

    expect(fn).toHaveBeenCalledWith(
      "https://x.test/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.text).toBe("transcribed");
    expect(result.model).toBe("test-tts-model");
  });

  it("dispatches to a custom wire named via preset providerRequestMetadata.transcriptionWire", async () => {
    const customWire: TranscriptionWire = {
      id: "gateway-test-custom-transcription-wire",
      transcribe: async () => ({
        text: "custom",
        usage: null,
        warnings: [],
      }),
    };
    registerTranscriptionWire(customWire);

    const { gateway } = setup({
      providerRequestMetadata: {
        transcriptionWire: "gateway-test-custom-transcription-wire",
      },
    });

    const result = await gateway.transcribeAudio({
      presetId: "tts-primary",
      audio: { data: new Uint8Array([1]), mimeType: "audio/wav" },
    });

    expect(result.text).toBe("custom");
  });

  it("throws a clear error for an unregistered transcriptionWire id", async () => {
    const { gateway } = setup({
      providerRequestMetadata: { transcriptionWire: "ghost" },
    });

    await expect(
      gateway.transcribeAudio({
        presetId: "tts-primary",
        audio: { data: new Uint8Array([1]), mimeType: "audio/wav" },
      }),
    ).rejects.toThrow(/unknown transcription wire "ghost"/);
  });
});
