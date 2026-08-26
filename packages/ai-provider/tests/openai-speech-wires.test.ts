import { describe, it, expect, vi, afterEach } from "vitest";
import { Request as UndiciRequest } from "undici";
import { openAiSpeechWire } from "../src/speech/openai-speech-wire.js";
import { openAiTranscriptionWire } from "../src/speech/openai-transcription-wire.js";
import type { ProviderConfig } from "../src/types.js";

const config: ProviderConfig = {
  provider: "test",
  baseUrl: "https://x.test",
  apiKey: "k",
  protocol: "openai-chat-v1",
};

afterEach(() => vi.unstubAllGlobals());

describe("openai-speech wire", () => {
  function mockSpeechFetch(status = 200) {
    const fn = vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Bad Request",
      headers: new Headers({ "content-type": "audio/mpeg" }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      text: async () => JSON.stringify({ error: { message: "boom" } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("POSTs /audio/speech with model/input/voice/format and returns bytes", async () => {
    const fn = mockSpeechFetch();

    const result = await openAiSpeechWire.synthesize(config, {
      model: "tts-1",
      text: "hello",
      voice: "alloy",
      format: "mp3",
    });

    expect(fn).toHaveBeenCalledWith(
      "https://x.test/v1/audio/speech",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(
      (fn.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({
      model: "tts-1",
      input: "hello",
      voice: "alloy",
      format: "mp3",
    });
    expect(result.audio.mimeType).toBe("audio/mpeg");
    expect(result.audio.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.warnings).toEqual([]);
  });

  it("spreads extra metadata but strips speechWire and parameterOverrides", async () => {
    const fn = mockSpeechFetch();

    await openAiSpeechWire.synthesize(config, {
      model: "tts-1",
      text: "hello",
      providerRequestMetadata: {
        speechWire: "openai-speech",
        parameterOverrides: { temperature: 0.5 },
        speed: 1.2,
      },
    });

    const body = JSON.parse(
      (fn.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.speed).toBe(1.2);
    expect(body).not.toHaveProperty("speechWire");
    expect(body).not.toHaveProperty("parameterOverrides");
  });

  it("throws on non-2xx responses", async () => {
    mockSpeechFetch(400);

    await expect(
      openAiSpeechWire.synthesize(config, { model: "tts-1", text: "hello" }),
    ).rejects.toThrow(/boom/);
  });
});

describe("openai-transcription wire", () => {
  function mockTranscriptionFetch(json: unknown) {
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(json),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("POSTs /audio/transcriptions as FormData and parses text + usage", async () => {
    const fn = mockTranscriptionFetch({
      text: "hello world",
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });

    const result = await openAiTranscriptionWire.transcribe(config, {
      model: "whisper-1",
      audio: {
        data: new Uint8Array([9, 9]),
        mimeType: "audio/wav",
        fileName: "clip.wav",
      },
      providerRequestMetadata: {
        transcriptionWire: "openai-transcription",
        language: "en",
      },
    });

    expect(fn).toHaveBeenCalledWith(
      "https://x.test/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
    );
    const formData = (fn.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(formData.get("model")).toBe("whisper-1");
    expect(formData.get("language")).toBe("en");
    expect(formData.get("transcriptionWire")).toBeNull();
    expect(formData.get("file")).toBeInstanceOf(Blob);

    // Production uses the package-pinned npm Undici implementation. Its
    // FormData brand must match or the body degrades to `[object FormData]`.
    const transportRequest = new UndiciRequest("https://x.test", {
      method: "POST",
      body: formData as never,
    });
    expect(transportRequest.headers.get("content-type")).toMatch(
      /^multipart\/form-data; boundary=/,
    );
    const serializedBody = await transportRequest.text();
    expect(serializedBody).toContain('name="model"');
    expect(serializedBody).toContain("whisper-1");
    expect(serializedBody).toContain('filename="clip.wav"');
    expect(serializedBody).toContain('name="language"');
    expect(result.text).toBe("hello world");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(result.warnings).toEqual([]);
  });

  it("returns null usage when the response has none", async () => {
    mockTranscriptionFetch({ text: "no usage" });

    const result = await openAiTranscriptionWire.transcribe(config, {
      model: "whisper-1",
      audio: { data: new Uint8Array([1]), mimeType: "audio/mpeg" },
    });

    expect(result.text).toBe("no usage");
    expect(result.usage).toBeNull();
  });
});
