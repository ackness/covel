/**
 * Tests for RuntimeHandlerContext.generateImage injection.
 * TDD: these tests define the expected shape of the context,
 * running BEFORE the implementation is in place.
 */
import { describe, it, expect, vi } from "vitest";
import type { RuntimeHandlerContext } from "../src/types.js";

describe("RuntimeHandlerContext.generateImage", () => {
  it("should allow generateImage to be defined optionally", () => {
    // A handler context without generateImage is valid
    const ctx: RuntimeHandlerContext = {
      runtimeId: "test-runtime",
      pluginId: "test-plugin",
      locale: "zh-CN",
      context: {},
    };
    expect(ctx.generateImage).toBeUndefined();
  });

  it("should accept generateImage returning url", async () => {
    const mockGenerateImage = vi.fn().mockResolvedValue({ url: "https://example.com/image.png" });

    const ctx: RuntimeHandlerContext = {
      runtimeId: "test-runtime",
      pluginId: "test-plugin",
      locale: "zh-CN",
      context: {},
      generateImage: mockGenerateImage,
    };

    const result = await ctx.generateImage!("一朵花");
    expect(result.url).toBe("https://example.com/image.png");
    expect(mockGenerateImage).toHaveBeenCalledWith("一朵花");
  });

  it("should accept generateImage with referenceUrl option", async () => {
    const mockGenerateImage = vi.fn().mockResolvedValue({ url: "https://example.com/new.png" });

    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "zh-CN",
      context: {},
      generateImage: mockGenerateImage,
    };

    const result = await ctx.generateImage!("A knight in armor", {
      referenceUrl: "https://example.com/prev.png",
      providerRequestMetadata: { imageFormat: "dashscope-wan", size: "1024*1024" },
    });

    expect(result.url).toBe("https://example.com/new.png");
    expect(mockGenerateImage).toHaveBeenCalledWith("A knight in armor", {
      referenceUrl: "https://example.com/prev.png",
      providerRequestMetadata: { imageFormat: "dashscope-wan", size: "1024*1024" },
    });
  });
});
