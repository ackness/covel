import { describe, expect, it, vi } from "vitest";
import { createRuntimeImagesContext } from "../src/function-runtime/runtime-images-context.js";

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
    ingestUrl: vi.fn(
      async (_url: string, opts?: { meta?: Record<string, unknown> }) => {
        n += 1;
        const asset: StoredAsset = {
          id: `media-${n}`,
          mime: "image/png",
          size: 1,
          meta: opts?.meta ?? {},
        };
        assets.push(asset);
        return { id: asset.id, mime: asset.mime, size: asset.size };
      },
    ),
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

function makeGatewayStub(
  images: ReadonlyArray<
    | { kind: "bytes"; bytes: Uint8Array; mime: string }
    | { kind: "url"; url: string; mime: string }
  >,
  warnings: readonly string[] = [],
) {
  return { generateImage: vi.fn(async () => ({ images, warnings })) };
}

describe("createRuntimeImagesContext", () => {
  it("persists bytes via put and URLs via ingestUrl, stamping framework metadata", async () => {
    const { media, mediaStore } = makeMediaStub();
    const gateway = makeGatewayStub(
      [
        { kind: "bytes", bytes: new Uint8Array([1, 2, 3]), mime: "image/png" },
        { kind: "url", url: "https://example.test/a.png", mime: "image/png" },
      ],
      ["low quality"],
    );
    const ctx = createRuntimeImagesContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "img-plugin",
    });

    const result = await ctx.generate({
      prompt: "a cat",
      metadata: { kind: "portrait", sceneId: "scene-1" },
    });

    expect(result.cached).toBe(false);
    expect(result.warnings).toEqual(["low quality"]);
    expect(result.refs).toHaveLength(2);

    expect(media.put).toHaveBeenCalledTimes(1);
    expect(media.ingestUrl).toHaveBeenCalledTimes(1);
    expect(media.ingestUrl).toHaveBeenCalledWith(
      "https://example.test/a.png",
      expect.objectContaining({
        allowedMimes: ["image/png", "image/jpeg", "image/webp"],
      }),
    );

    const [, mime, meta] = media.put.mock.calls[0]!;
    expect(mime).toBe("image/png");
    expect(meta).toMatchObject({
      kind: "portrait",
      sceneId: "scene-1",
      pluginId: "img-plugin",
    });
    expect(typeof meta.promptHash).toBe("string");
  });

  it("never lets plugin-supplied metadata override framework-injected keys", async () => {
    const { media, mediaStore } = makeMediaStub();
    const gateway = makeGatewayStub([
      { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
    ]);
    const ctx = createRuntimeImagesContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "real-plugin",
    });

    await ctx.generate({
      prompt: "a dog",
      metadata: { pluginId: "evil", promptHash: "fake" },
    });

    const [, , meta] = media.put.mock.calls[0]!;
    expect(meta.pluginId).toBe("real-plugin");
    expect(meta.promptHash).not.toBe("fake");
  });

  it("returns a cached result and skips the gateway when promptHash already exists", async () => {
    const { media, mediaStore } = makeMediaStub();
    const gateway = makeGatewayStub([
      { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
    ]);
    const ctx = createRuntimeImagesContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "img-plugin",
    });

    const first = await ctx.generate({ prompt: "same prompt" });
    expect(first.cached).toBe(false);

    gateway.generateImage.mockClear();
    const second = await ctx.generate({ prompt: "same prompt" });

    expect(second.cached).toBe(true);
    expect(second.warnings).toEqual([]);
    expect(second.refs).toHaveLength(1);
    expect(second.refs[0]!.id).toBe(first.refs[0]!.id);
    expect(gateway.generateImage).not.toHaveBeenCalled();
  });

  it("does not hit the cache when generation params differ", async () => {
    const { media, mediaStore } = makeMediaStub();
    const gateway = makeGatewayStub([
      { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
    ]);
    const ctx = createRuntimeImagesContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "img-plugin",
    });

    await ctx.generate({ prompt: "same prompt", size: "512x512" });
    gateway.generateImage.mockClear();
    const second = await ctx.generate({
      prompt: "same prompt",
      size: "1024x1024",
    });

    expect(second.cached).toBe(false);
    expect(gateway.generateImage).toHaveBeenCalledTimes(1);
  });

  it("forwards the abort signal to the gateway without affecting promptHash", async () => {
    const { media, mediaStore } = makeMediaStub();
    const gateway = makeGatewayStub([
      { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
    ]);
    const ctx = createRuntimeImagesContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "img-plugin",
    });
    const controller = new AbortController();

    await ctx.generate({ prompt: "same prompt", signal: controller.signal });
    expect(gateway.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );

    gateway.generateImage.mockClear();
    const second = await ctx.generate({ prompt: "same prompt" });

    expect(second.cached).toBe(true);
    expect(gateway.generateImage).not.toHaveBeenCalled();
  });
});
