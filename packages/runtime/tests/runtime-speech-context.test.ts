import { describe, expect, it, vi } from "vitest";
import { createRuntimeSpeechContext } from "../src/function-runtime/runtime-speech-context.js";

interface StoredAsset {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly meta: Record<string, unknown>;
}

function makeMediaStub() {
  const assets: StoredAsset[] = [];
  let n = 0;

  const media = {
    put: vi.fn(
      async (
        bytes: Uint8Array,
        mime: string,
        meta?: Record<string, unknown>,
      ) => {
        n += 1;
        const asset: StoredAsset = {
          id: `media-${n}`,
          mime,
          size: bytes.byteLength,
          meta: meta ?? {},
        };
        assets.push(asset);
        return { id: asset.id, mime: asset.mime, size: asset.size };
      },
    ),
    get: vi.fn(async () => new Uint8Array([42])),
  };

  const listByMetadata = vi.fn(
    async (_sessionId: string, filter: Record<string, unknown>) =>
      assets.filter((asset) =>
        Object.entries(filter).every(
          ([key, value]) => asset.meta[key] === value,
        ),
      ),
  );

  return { assets, media, mediaStore: { listByMetadata } };
}

function makeGatewayStub(warnings: readonly string[] = []) {
  return {
    synthesizeSpeech: vi.fn(async () => ({
      audio: { mimeType: "audio/mpeg", data: new Uint8Array([1, 2, 3]) },
      warnings,
    })),
    transcribeAudio: vi.fn(async () => ({
      text: "transcribed text",
      warnings: [] as readonly string[],
    })),
  };
}

describe("createRuntimeSpeechContext — generate", () => {
  it("persists audio via put, stamping framework metadata", async () => {
    const { media, mediaStore } = makeMediaStub();
    const gateway = makeGatewayStub(["fell back to mp3"]);
    const ctx = createRuntimeSpeechContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "tts-plugin",
    });

    const result = await ctx.generate({
      text: "hello world",
      voice: "alloy",
      metadata: { turnId: "t1" },
    });

    expect(result.cached).toBe(false);
    expect(result.warnings).toEqual(["fell back to mp3"]);
    expect(result.refs).toHaveLength(1);

    const [, mime, meta] = media.put.mock.calls[0]!;
    expect(mime).toBe("audio/mpeg");
    expect(meta).toMatchObject({ turnId: "t1", pluginId: "tts-plugin" });
    expect(typeof meta.promptHash).toBe("string");
  });

  it("never lets plugin-supplied metadata override framework-injected keys", async () => {
    const { media, mediaStore } = makeMediaStub();
    const gateway = makeGatewayStub();
    const ctx = createRuntimeSpeechContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "real-plugin",
    });

    await ctx.generate({
      text: "hello",
      metadata: { pluginId: "evil", promptHash: "fake" },
    });

    const [, , meta] = media.put.mock.calls[0]!;
    expect(meta.pluginId).toBe("real-plugin");
    expect(meta.promptHash).not.toBe("fake");
  });

  it("returns a cached result and skips the gateway for identical params", async () => {
    const { media, mediaStore } = makeMediaStub();
    const gateway = makeGatewayStub();
    const ctx = createRuntimeSpeechContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "tts-plugin",
    });

    const first = await ctx.generate({
      text: "same text",
      metadata: { turnId: "t1" },
    });
    expect(first.cached).toBe(false);

    gateway.synthesizeSpeech.mockClear();
    const second = await ctx.generate({
      text: "same text",
      metadata: { turnId: "t2" },
    });

    expect(second.cached).toBe(true);
    expect(second.refs[0]!.id).toBe(first.refs[0]!.id);
    // Cache hits carry THIS call's metadata, not the first call's.
    expect(second.refs[0]!.meta).toMatchObject({ turnId: "t2" });
    expect(gateway.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("does not hit the cache when voice or format differ", async () => {
    const { mediaStore, media } = makeMediaStub();
    const gateway = makeGatewayStub();
    const ctx = createRuntimeSpeechContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "tts-plugin",
    });

    await ctx.generate({ text: "same text", voice: "alloy" });
    gateway.synthesizeSpeech.mockClear();

    const other = await ctx.generate({ text: "same text", voice: "nova" });
    expect(other.cached).toBe(false);
    expect(gateway.synthesizeSpeech).toHaveBeenCalledTimes(1);

    gateway.synthesizeSpeech.mockClear();
    const formatChange = await ctx.generate({
      text: "same text",
      voice: "alloy",
      format: "wav",
    });
    expect(formatChange.cached).toBe(false);
    expect(gateway.synthesizeSpeech).toHaveBeenCalledTimes(1);
  });

  it("forwards the abort signal without affecting promptHash", async () => {
    const { mediaStore, media } = makeMediaStub();
    const gateway = makeGatewayStub();
    const ctx = createRuntimeSpeechContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "tts-plugin",
    });
    const controller = new AbortController();

    await ctx.generate({ text: "same text", signal: controller.signal });
    expect(gateway.synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );

    gateway.synthesizeSpeech.mockClear();
    const second = await ctx.generate({ text: "same text" });
    expect(second.cached).toBe(true);
    expect(gateway.synthesizeSpeech).not.toHaveBeenCalled();
  });
});

describe("createRuntimeSpeechContext — transcribe", () => {
  it("accepts raw bytes and passes them through to the gateway", async () => {
    const { mediaStore, media } = makeMediaStub();
    const gateway = makeGatewayStub();
    const ctx = createRuntimeSpeechContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "tts-plugin",
    });

    const result = await ctx.transcribe({
      audio: { data: new Uint8Array([9]), mimeType: "audio/wav" },
    });

    expect(result.text).toBe("transcribed text");
    expect(gateway.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ mimeType: "audio/wav" }),
      }),
    );
    expect(media.get).not.toHaveBeenCalled();
  });

  it("accepts a MediaRef, loading bytes via media.get", async () => {
    const { mediaStore, media } = makeMediaStub();
    const gateway = makeGatewayStub();
    const ctx = createRuntimeSpeechContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "tts-plugin",
    });

    const result = await ctx.transcribe({
      audio: { id: "media-7", mime: "audio/mpeg", size: 1 },
    });

    expect(result.text).toBe("transcribed text");
    expect(media.get).toHaveBeenCalledTimes(1);
    expect(gateway.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({
          data: new Uint8Array([42]),
          mimeType: "audio/mpeg",
        }),
      }),
    );
  });

  it("never consults the dedup cache", async () => {
    const { mediaStore, media } = makeMediaStub();
    const gateway = makeGatewayStub();
    const ctx = createRuntimeSpeechContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "tts-plugin",
    });

    await ctx.transcribe({
      audio: { data: new Uint8Array([9]), mimeType: "audio/wav" },
    });

    expect(mediaStore.listByMetadata).not.toHaveBeenCalled();
    expect(media.put).not.toHaveBeenCalled();
  });
});
