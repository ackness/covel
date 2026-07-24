// Unit tests for runtimes/image-generator/handler.js.
//
// The handler is a pure function of its FunctionHandlerContext, so these
// tests import it directly and hand it a bare mock ctx — no framework
// runtime needed.
import { describe, expect, it, vi } from "vitest";
import handler from "../runtimes/image-generator/handler.js";

const TOPIC = "image.generate.requested";

function makeRef(id = "media-1") {
  return { id, mime: "image/png", size: 1024 };
}

function makeCtx(overrides = {}) {
  return {
    turnId: "turn-1",
    triggerEvent: {
      topic: TOPIC,
      data: { prompt: "a koi pond at dusk", promptMode: "text" },
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

describe("image-generator handler", () => {
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

  it("calls ctx.images.generate with the raw x-separated size, passthrough negativePrompt, and metadata", async () => {
    const ctx = makeCtx({
      userSettings: {
        modelPresetId: "image",
        imageSize: "1440x720",
        n: 1,
        quality: "high",
        negativePrompt: "blurry, watermark",
        requestTimeoutMs: 60000,
      },
    });

    await handler(ctx);

    expect(ctx.images.generate).toHaveBeenCalledTimes(1);
    const [call] = ctx.images.generate.mock.calls[0];
    expect(call).toMatchObject({
      presetId: "image",
      prompt: "a koi pond at dusk",
      negativePrompt: "blurry, watermark",
      size: "1440x720", // raw x-separated form — the wire does the *-conversion, not this handler
      quality: "high",
      n: 1,
      metadata: { source: "dashscope-image-gen", turnId: "turn-1" },
    });
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits negativePrompt when the setting is empty", async () => {
    const ctx = makeCtx({ userSettings: { negativePrompt: "" } });

    await handler(ctx);

    const [call] = ctx.images.generate.mock.calls[0];
    expect(call.negativePrompt).toBeUndefined();
  });

  it("surfaces wire warnings into the logger and the done record", async () => {
    const warnings = [
      "model wan2.7-image-pro rejects negative_prompt; dropped",
    ];
    const ctx = makeCtx({
      images: {
        generate: vi
          .fn()
          .mockResolvedValue({ refs: [makeRef()], warnings, cached: false }),
      },
    });

    const result = await handler(ctx);

    expect(result.status).toBe("done");
    expect(result.warnings).toEqual(warnings);
    // warnings land on the plugin-data record so the gallery can show them,
    // and on the completed _logs entry for debug-page visibility
    expect(result.pluginData[0].value.warnings).toEqual(warnings);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "image.generate.completed",
      expect.objectContaining({ warnings }),
    );
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
    expect(result.pluginData[0].key).toBe(result.imageId); // single ref keeps the bare imageId key
  });

  it("keys multi-ref results as <imageId>-1, <imageId>-2 and exposes refs[]", async () => {
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
          .mockRejectedValue(
            new Error("DashScope WAN generation FAILED: boom"),
          ),
      },
    });

    const result = await handler(ctx);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("DashScope WAN generation FAILED: boom");
  });
});
