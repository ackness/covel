import { describe, expect, it, vi } from "vitest";
import { createRuntimeImagesContext } from "../src/function-runtime/runtime-images-context.js";
import type { ResolvedSlotForPlugin } from "@covel/shared/plugin-runtime";
import { AiProviderError } from "@covel/ai-provider";

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
  const resolveSlot = vi.fn((): ResolvedSlotForPlugin | null => ({
    presetId: "slot-image",
    provider: "test",
    model: "image-model",
    protocol: "openai-chat-v1",
    baseUrl: "https://images.test/v1",
    tag: "image",
    metadata: { imageWire: "openai-images" },
  }));
  return {
    resolveSlot,
    generateImage: vi.fn(async () => ({
      target: resolveSlot()!,
      images,
      warnings,
    })),
  };
}

describe("createRuntimeImagesContext", () => {
  it("checks availability without generating and propagates unexpected errors", () => {
    const { media, mediaStore } = makeMediaStub();
    const gateway = makeGatewayStub([]);
    const ctx = createRuntimeImagesContext(gateway, mediaStore, media, {
      sessionId: "s",
      pluginId: "p",
    });
    expect(ctx.isAvailable()).toBe(true);
    expect(gateway.resolveSlot).toHaveBeenCalledWith({
      presetId: "image",
      fallbackTag: "image",
    });
    gateway.resolveSlot.mockReturnValue(null);
    expect(ctx.isAvailable("background")).toBe(false);
    gateway.resolveSlot.mockImplementation(() => {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        provider: "test",
        message: "missing image role",
        retriable: false,
      });
    });
    expect(ctx.isAvailable()).toBe(false);
    gateway.resolveSlot.mockImplementation(() => {
      throw new Error("unexpected resolution failure");
    });
    expect(() => ctx.isAvailable()).toThrow("unexpected resolution failure");
    expect(gateway.generateImage).not.toHaveBeenCalled();
    expect(mediaStore.listByMetadata).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "caches the dispatched target when the role changes during lookup (ABA=%s)",
    async (aba) => {
      const { media, mediaStore } = makeMediaStub();
      const gateway = makeGatewayStub([
        { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
      ]);
      const ctx = createRuntimeImagesContext(gateway, mediaStore, media, {
        sessionId: "s",
        pluginId: "p",
      });
      const targetA = gateway.resolveSlot()!;
      const targetB = { ...targetA, model: "model-b" };
      mediaStore.listByMetadata.mockImplementationOnce(async () => {
        gateway.resolveSlot.mockReturnValue(targetB);
        return [];
      });
      if (aba)
        gateway.generateImage.mockImplementationOnce(async () => {
          gateway.resolveSlot.mockReturnValue(targetA);
          return {
            target: targetB,
            images: [
              { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
            ],
            warnings: [],
          };
        });
      const generatedB = await ctx.generate({ prompt: "same scene" });
      gateway.resolveSlot.mockReturnValue(targetA);
      expect((await ctx.generate({ prompt: "same scene" })).cached).toBe(false);
      gateway.resolveSlot.mockReturnValue(targetB);
      const cachedB = await ctx.generate({ prompt: "same scene" });
      expect(cachedB.cached).toBe(true);
      expect(cachedB.refs[0]!.id).toBe(generatedB.refs[0]!.id);
      expect(gateway.generateImage).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["model", "provider", "baseUrl", "metadata"] as const)(
    "invalidates cached images when resolved %s changes under the same role",
    async (field) => {
      const { media, mediaStore } = makeMediaStub();
      const gateway = makeGatewayStub([
        { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
      ]);
      const ctx = createRuntimeImagesContext(gateway, mediaStore, media, {
        sessionId: "sess-1",
        pluginId: "image-workflow",
      });
      const target = gateway.resolveSlot()!;
      await ctx.generate({ prompt: "same scene" });
      gateway.resolveSlot.mockReturnValue({
        ...target,
        [field]:
          field === "metadata" ? { imageWire: "community/custom" } : "changed",
      });

      const result = await ctx.generate({ prompt: "same scene" });

      expect(result.cached).toBe(false);
      expect(gateway.generateImage).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps credentials out of cache identity and does not depend on metadata key order", async () => {
    const { media, mediaStore, assets } = makeMediaStub();
    const gateway = makeGatewayStub([
      { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
    ]);
    const target = gateway.resolveSlot()!;
    gateway.resolveSlot.mockReturnValue({
      ...target,
      apiKey: "synthetic-key-one",
      metadata: { imageWire: "openai-images", style: "vivid" },
    });
    const ctx = createRuntimeImagesContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "image-workflow",
    });
    await ctx.generate({ prompt: "same scene" });
    gateway.resolveSlot.mockReturnValue({
      ...target,
      apiKey: "synthetic-key-two",
      metadata: { style: "vivid", imageWire: "openai-images" },
    });
    expect((await ctx.generate({ prompt: "same scene" })).cached).toBe(true);
    expect(JSON.stringify(assets)).not.toContain("synthetic-key");
    expect(gateway.generateImage).toHaveBeenCalledTimes(1);
  });

  it("requires a valid model binding even when a previous image was cached", async () => {
    const { media, mediaStore } = makeMediaStub();
    const gateway = makeGatewayStub([
      { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
    ]);
    const ctx = createRuntimeImagesContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "image-workflow",
    });
    await ctx.generate({ prompt: "same scene" });
    gateway.resolveSlot.mockReturnValue(null);
    await expect(ctx.generate({ prompt: "same scene" })).rejects.toMatchObject({
      code: "CONFIG_ERROR",
      retriable: false,
    });
    expect(gateway.generateImage).toHaveBeenCalledTimes(1);
  });

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

    const first = await ctx.generate({
      prompt: "same prompt",
      metadata: { kind: "avatar" },
    });
    expect(first.cached).toBe(false);

    gateway.generateImage.mockClear();
    const second = await ctx.generate({ prompt: "same prompt" });

    expect(second.cached).toBe(true);
    expect(second.warnings).toEqual([]);
    expect(second.refs).toHaveLength(1);
    expect(second.refs[0]!.id).toBe(first.refs[0]!.id);
    // The returned ref carries THIS call's metadata, not the first call's:
    // this call passed none, so the first call's `kind: "avatar"` must not
    // leak onto it (only the framework-injected keys remain).
    expect(second.refs[0]!.meta).toMatchObject({ pluginId: "img-plugin" });
    expect(second.refs[0]!.meta).not.toHaveProperty("kind");
    expect(gateway.generateImage).not.toHaveBeenCalled();
  });

  it("stamps each cache hit with the calling turn's own metadata, not the first call's", async () => {
    const { media, mediaStore } = makeMediaStub();
    const gateway = makeGatewayStub([
      { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
    ]);
    const ctx = createRuntimeImagesContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "img-plugin",
    });

    const first = await ctx.generate({
      prompt: "same prompt",
      metadata: { sceneId: "scene-1" },
    });

    gateway.generateImage.mockClear();
    const second = await ctx.generate({
      prompt: "same prompt",
      metadata: { sceneId: "scene-2" },
    });

    expect(second.cached).toBe(true);
    expect(second.refs[0]!.id).toBe(first.refs[0]!.id);
    expect(second.refs[0]!.meta).toMatchObject({ sceneId: "scene-2" });
    expect(gateway.generateImage).not.toHaveBeenCalled();
  });

  it("does not serve a partial result as cached when a mid-batch persist fails", async () => {
    const { media, mediaStore } = makeMediaStub();
    const gateway = makeGatewayStub([
      { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
      { kind: "url", url: "https://example.test/b.png", mime: "image/png" },
    ]);
    const ctx = createRuntimeImagesContext(gateway, mediaStore, media, {
      sessionId: "sess-1",
      pluginId: "img-plugin",
    });

    media.ingestUrl.mockImplementationOnce(async () => {
      throw new Error("network error");
    });

    await expect(ctx.generate({ prompt: "two cats", n: 2 })).rejects.toThrow(
      "network error",
    );

    // Only the bytes image persisted; the promptHash asset is a partial
    // result (1 of 2 requested) and must not be treated as a cache hit.
    gateway.generateImage.mockClear();
    const retry = await ctx.generate({ prompt: "two cats", n: 2 });

    expect(retry.cached).toBe(false);
    expect(gateway.generateImage).toHaveBeenCalledTimes(1);
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
