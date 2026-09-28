import { describe, expect, it, vi } from "vitest";
import {
  runImageGeneration,
  type ImageGenerationHandlerContext,
  type ImageGenerationPluginConfig,
} from "../src/image-generation.js";

const config: ImageGenerationPluginConfig = {
  source: "test-image-flow",
  triggerTopic: "image.generate.requested",
  planRequest(_settings, { prompt }) {
    return {
      prompt,
      presetId: "image",
      size: "1024x1024",
      n: 1,
      requestTimeoutMs: 30000,
    };
  },
};

function makeContext() {
  const available = vi.fn(() => false);
  const generate = vi.fn().mockResolvedValue({
    refs: [{ id: "media-1", mime: "image/png", size: 4 }],
    warnings: [],
    cached: false,
  });
  const set = vi.fn().mockResolvedValue(undefined);
  const ctx: ImageGenerationHandlerContext = {
    triggerEvent: {
      topic: "image.generate.requested",
      data: { prompt: "a quiet garden" },
    },
    images: { isAvailable: available, generate },
    pluginData: { set },
  };
  return { ctx, available, generate, set };
}

describe("runImageGeneration model availability", () => {
  it("skips repeated missing-model attempts without gallery writes, then generates when configured", async () => {
    const { ctx, available, generate, set } = makeContext();

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await runImageGeneration(ctx, config)).toEqual({
        outcome: "skipped",
        skipReason: "image model unavailable",
      });
    }
    expect(available).toHaveBeenCalledTimes(2);
    expect(available).toHaveBeenNthCalledWith(1, "image");
    expect(generate).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();

    available.mockReturnValue(true);
    const result = await runImageGeneration(ctx, config);

    expect(result.outcome).toBe("success");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      "images",
      expect.any(String),
      expect.objectContaining({ status: "pending" }),
    );
  });

  it("skips when the images context is absent", async () => {
    const { ctx, set } = makeContext();
    expect(
      await runImageGeneration({ ...ctx, images: undefined }, config),
    ).toEqual({
      outcome: "skipped",
      skipReason: "image model unavailable",
    });
    expect(set).not.toHaveBeenCalled();
  });

  it("keeps provider failures visible after an available model starts generating", async () => {
    const { ctx, available, generate, set } = makeContext();
    available.mockReturnValue(true);
    generate.mockRejectedValue(new Error("provider failed"));

    const result = await runImageGeneration(ctx, config);

    expect(result.outcome).toBe("success");
    expect(result.value).toMatchObject({
      status: "failed",
      error: "provider failed",
    });
    expect(set).toHaveBeenLastCalledWith(
      "images",
      expect.any(String),
      expect.objectContaining({ status: "failed" }),
    );
  });
});
