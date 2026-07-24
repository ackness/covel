// Unit tests for runtimes/image-generator/handler.js.
//
// The handler is a pure function of its FunctionHandlerContext, so these
// tests import it directly and hand it a bare mock ctx — no framework
// runtime needed. Shape mirrors dashscope-image-gen's suite; the cases
// unique to this plugin are the OpenAI size normalization ("*" → "x",
// lowercase) and the style-into-prompt folding.
import { describe, expect, it, vi } from "vitest";
import handler from "../runtimes/image-generator/handler.js";

const TOPIC = "openai-image.generate.requested";

function makeRef(id = "media-1") {
  return { id, mime: "image/png", size: 1024 };
}

function makeCtx(overrides = {}) {
  return {
    turnId: "turn-1",
    triggerEvent: {
      topic: TOPIC,
      data: {
        prompt: "a koi pond at dusk",
        promptMode: "text",
        composition: "single-scene",
      },
    },
    userSettings: {},
    pluginData: { set: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    images: {
      generate: vi
        .fn()
        .mockResolvedValue({ refs: [makeRef()], warnings: [], cached: false }),
    },
    ...overrides,
  };
}

describe("image-generator handler (openai)", () => {
  it("fails without writing a pending record when ctx.images is unavailable", async () => {
    const ctx = makeCtx({ images: undefined });
    const result = await handler(ctx);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/ctx\.images is unavailable/);
    expect(ctx.pluginData.set).not.toHaveBeenCalled();
  });

  it("skips when no prompt can be extracted", async () => {
    const ctx = makeCtx({ triggerEvent: undefined });
    const result = await handler(ctx);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no-prompt-found");
    expect(ctx.images.generate).not.toHaveBeenCalled();
  });

  it("falls back to manualPayload.prompt for direct plugin-rpc invocations", async () => {
    const ctx = makeCtx({
      triggerEvent: undefined,
      manualPayload: { prompt: "manual prompt", composition: "comic-strip" },
    });

    const result = await handler(ctx);

    expect(result.status).toBe("done");
    expect(result.composition).toBe("comic-strip");
    const [call] = ctx.images.generate.mock.calls[0];
    expect(call.prompt).toBe("manual prompt");
  });

  it('normalizes a DashScope-style "*" size to lowercase x-separated form', async () => {
    const ctx = makeCtx({ userSettings: { imageSize: "1024*1536" } });

    await handler(ctx);

    const [call] = ctx.images.generate.mock.calls[0];
    expect(call.size).toBe("1024x1536");
  });

  it("folds the style setting into the prompt (no dedicated wire parameter)", async () => {
    const ctx = makeCtx({ userSettings: { style: "watercolor" } });

    const result = await handler(ctx);

    const [call] = ctx.images.generate.mock.calls[0];
    expect(call.prompt).toBe("a koi pond at dusk, style: watercolor");
    expect(result.prompt).toBe("a koi pond at dusk, style: watercolor");
  });

  it("passes preset, count, quality, timeout signal, and metadata through", async () => {
    const ctx = makeCtx({
      userSettings: {
        modelPresetId: "openai-image",
        imageSize: "1024x1024",
        n: 2,
        quality: "high",
        requestTimeoutMs: 60000,
      },
      images: {
        generate: vi.fn().mockResolvedValue({
          refs: [makeRef("a"), makeRef("b")],
          warnings: [],
          cached: false,
        }),
      },
    });

    await handler(ctx);

    const [call] = ctx.images.generate.mock.calls[0];
    expect(call).toMatchObject({
      presetId: "openai-image",
      prompt: "a koi pond at dusk",
      size: "1024x1024",
      quality: "high",
      n: 2,
      metadata: { source: "openai-image-gen", turnId: "turn-1" },
    });
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("keys multi-ref results as <imageId>-1, <imageId>-2 and emits per-image assetGenerations", async () => {
    const ctx = makeCtx({
      images: {
        generate: vi.fn().mockResolvedValue({
          refs: [makeRef("a"), makeRef("b")],
          warnings: [],
          cached: false,
        }),
      },
    });

    const result = await handler(ctx);

    expect(result.refs).toHaveLength(2);
    expect(result.pluginData.map((entry) => entry.key)).toEqual([
      `${result.imageId}-1`,
      `${result.imageId}-2`,
    ]);
    expect(result.assetGenerations).toHaveLength(2);
    expect(result.assetGenerations[0].modality).toBe("image");
  });

  it("marks the record cached for a promptHash-dedup hit and keeps the bare imageId key", async () => {
    const ctx = makeCtx({
      images: {
        generate: vi.fn().mockResolvedValue({
          refs: [makeRef("cached-ref")],
          warnings: [],
          cached: true,
        }),
      },
    });

    const result = await handler(ctx);

    expect(result.cached).toBe(true);
    expect(result.pluginData[0].value.cached).toBe(true);
    expect(result.pluginData[0].key).toBe(result.imageId);
  });

  it("returns a failed record when the provider resolves with zero images", async () => {
    const ctx = makeCtx({
      images: {
        generate: vi.fn().mockResolvedValue({
          refs: [],
          warnings: ["no output"],
          cached: false,
        }),
      },
    });

    const result = await handler(ctx);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/no images/i);
    expect(ctx.pluginData.set).toHaveBeenLastCalledWith(
      "images",
      expect.any(String),
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("returns a failed record when ctx.images.generate throws", async () => {
    const ctx = makeCtx({
      images: {
        generate: vi
          .fn()
          .mockRejectedValue(new Error("OpenAI image generation FAILED: boom")),
      },
    });

    const result = await handler(ctx);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("OpenAI image generation FAILED: boom");
  });
});
