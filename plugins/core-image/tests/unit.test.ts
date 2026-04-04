import { describe, it, expect, vi } from "vitest";
import {
  buildEnhancePrompt,
  detectMultiScene,
  addImageResult,
  getRecentImageSummary,
  EMPTY_STATE,
  type ImageRequest,
  type ImageResult,
  type ImageState,
  type EnhancedPrompt,
} from "../server/image-logic.js";
import { requestStoryImageTool } from "../server/tools.js";
import { imageRuntimeHandler } from "../server/runtime-handler.js";
import { parseEnhancedResponse } from "../server/runtime-handler.js";
import { imageContextProvider } from "../server/context-provider.js";
import type { ToolExecutionContext } from "@covel/shared";
import type { RuntimeHandlerContext } from "@covel/plugin-runtime";

// ── Helpers ──────────────────────────────────────────────────

function makeToolCtx(input: unknown, locale = "en-US"): ToolExecutionContext {
  return {
    input,
    runtimeId: "image-generator",
    pluginId: "core-image",
    locale,
  };
}

function makeImageResult(overrides: Partial<ImageResult> = {}): ImageResult {
  return {
    imageId: overrides.imageId ?? "img-1",
    prompt: overrides.prompt ?? {
      original: "A dark forest scene",
      enhanced: "A haunting dark forest with twisted ancient trees",
      isMultiScene: false,
    },
    status: overrides.status ?? "ready",
    stylePreset: overrides.stylePreset ?? "cinematic",
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    imageUrl: overrides.imageUrl,
    error: overrides.error,
  };
}

function makeRequest(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return {
    storyBackground: overrides.storyBackground ?? "A medieval fantasy world",
    scenePrompt: overrides.scenePrompt ?? "The hero enters the dark cave",
    continuityNotes: overrides.continuityNotes,
    layoutPreference: overrides.layoutPreference,
    stylePreset: overrides.stylePreset,
    negativePrompt: overrides.negativePrompt,
  };
}

// ── image-logic unit tests ─────────────────────────────────────

describe("image-logic", () => {
  describe("buildEnhancePrompt", () => {
    it("includes story background and scene prompt", () => {
      const result = buildEnhancePrompt(makeRequest());

      expect(result).toContain("A medieval fantasy world");
      expect(result).toContain("The hero enters the dark cave");
    });

    it("includes style preset", () => {
      const result = buildEnhancePrompt(
        makeRequest({ stylePreset: "anime" }),
      );

      expect(result).toContain("Style preset: anime");
      expect(result).toContain("Apply anime style");
    });

    it("defaults style to cinematic", () => {
      const result = buildEnhancePrompt(makeRequest());

      expect(result).toContain("Style preset: cinematic");
    });

    it("includes world context when provided", () => {
      const result = buildEnhancePrompt(
        makeRequest(),
        "The kingdom of Eldoria, a land of magic and dragons",
      );

      expect(result).toContain("## World Context");
      expect(result).toContain("The kingdom of Eldoria");
    });

    it("includes characters when provided", () => {
      const result = buildEnhancePrompt(
        makeRequest(),
        undefined,
        "Aria: tall elf with silver hair",
      );

      expect(result).toContain("## Characters Present");
      expect(result).toContain("Aria: tall elf with silver hair");
    });

    it("includes continuity notes when provided", () => {
      const result = buildEnhancePrompt(
        makeRequest({ continuityNotes: "Previous scene had warm sunset tones" }),
      );

      expect(result).toContain("## Visual Continuity Notes");
      expect(result).toContain("Previous scene had warm sunset tones");
    });

    it("includes negative prompt when provided", () => {
      const result = buildEnhancePrompt(
        makeRequest({ negativePrompt: "no gore, no blood" }),
      );

      expect(result).toContain("## Negative Prompt");
      expect(result).toContain("no gore, no blood");
    });

    it("includes layout preference", () => {
      const result = buildEnhancePrompt(
        makeRequest({ layoutPreference: "comic" }),
      );

      expect(result).toContain("Layout preference: comic");
    });

    it("omits optional sections when not provided", () => {
      const result = buildEnhancePrompt(makeRequest());

      expect(result).not.toContain("## World Context");
      expect(result).not.toContain("## Characters Present");
      expect(result).not.toContain("## Visual Continuity Notes");
      expect(result).not.toContain("## Negative Prompt");
    });
  });

  describe("detectMultiScene", () => {
    it("detects Chinese multi-scene keywords", () => {
      const result = detectMultiScene("场景需要分镜展示");
      expect(result.isMultiScene).toBe(true);
      expect(result.reason).toContain("分镜");
    });

    it("detects Chinese '多场景' keyword", () => {
      const result = detectMultiScene("这是一个多场景画面");
      expect(result.isMultiScene).toBe(true);
      expect(result.reason).toContain("多场景");
    });

    it("detects Chinese '切换' keyword", () => {
      const result = detectMultiScene("画面切换到另一个地方");
      expect(result.isMultiScene).toBe(true);
    });

    it("detects English 'meanwhile' keyword", () => {
      const result = detectMultiScene(
        "The hero fought bravely. Meanwhile, the princess escaped.",
      );
      expect(result.isMultiScene).toBe(true);
      expect(result.reason).toContain("meanwhile");
    });

    it("detects 'at the same time'", () => {
      const result = detectMultiScene(
        "At the same time, the villain prepared his spell.",
      );
      expect(result.isMultiScene).toBe(true);
    });

    it("detects 'cut to' keyword", () => {
      const result = detectMultiScene("Cut to the interior of the castle.");
      expect(result.isMultiScene).toBe(true);
    });

    it("detects dialogue patterns", () => {
      const result = detectMultiScene(
        '「你好」她说。「很高兴认识你」他回答。',
      );
      expect(result.isMultiScene).toBe(true);
      expect(result.reason).toBe("dialogue pattern");
    });

    it("detects sequential cues", () => {
      const result = detectMultiScene(
        "First the hero drew his sword. Then he charged at the dragon.",
      );
      expect(result.isMultiScene).toBe(true);
      expect(result.reason).toBe("sequential cues");
    });

    it("detects Chinese sequential cues", () => {
      const result = detectMultiScene(
        "接着他拔出了剑，然后向龙冲去。",
      );
      expect(result.isMultiScene).toBe(true);
      expect(result.reason).toBe("sequential cues");
    });

    it("returns false for simple scene", () => {
      const result = detectMultiScene("A beautiful sunset over the mountains.");
      expect(result.isMultiScene).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it("returns false for single action", () => {
      const result = detectMultiScene("The warrior stands on the cliff.");
      expect(result.isMultiScene).toBe(false);
    });
  });

  describe("addImageResult", () => {
    it("adds result to the beginning of recentImages", () => {
      const existing = makeImageResult({ imageId: "existing-1" });
      const state: ImageState = { recentImages: [existing], maxHistory: 20 };
      const newResult = makeImageResult({ imageId: "new-1" });

      const updated = addImageResult(state, newResult);

      expect(updated.recentImages).toHaveLength(2);
      expect(updated.recentImages[0].imageId).toBe("new-1");
      expect(updated.recentImages[1].imageId).toBe("existing-1");
    });

    it("trims to maxHistory", () => {
      const results = Array.from({ length: 5 }, (_, i) =>
        makeImageResult({ imageId: `img-${i}` }),
      );
      const state: ImageState = { recentImages: results, maxHistory: 3 };
      const newResult = makeImageResult({ imageId: "new-1" });

      const updated = addImageResult(state, newResult);

      expect(updated.recentImages).toHaveLength(3);
      expect(updated.recentImages[0].imageId).toBe("new-1");
      expect(updated.recentImages[2].imageId).toBe("img-1");
    });

    it("does not mutate original state", () => {
      const original: ImageState = { recentImages: [], maxHistory: 20 };
      const newResult = makeImageResult();

      const updated = addImageResult(original, newResult);

      expect(original.recentImages).toHaveLength(0);
      expect(updated.recentImages).toHaveLength(1);
    });

    it("handles empty state", () => {
      const newResult = makeImageResult();
      const updated = addImageResult(EMPTY_STATE, newResult);

      expect(updated.recentImages).toHaveLength(1);
      expect(updated.maxHistory).toBe(20);
    });
  });

  describe("getRecentImageSummary", () => {
    it("returns empty message for no images (en)", () => {
      expect(getRecentImageSummary(EMPTY_STATE, "en-US")).toBe(
        "No images generated yet.",
      );
    });

    it("returns empty message for no images (zh)", () => {
      expect(getRecentImageSummary(EMPTY_STATE, "zh-CN")).toBe(
        "暂无已生成的插画。",
      );
    });

    it("formats image entries with status and style", () => {
      const state: ImageState = {
        recentImages: [makeImageResult()],
        maxHistory: 20,
      };

      const summary = getRecentImageSummary(state, "en-US");
      expect(summary).toContain("## Recent Images");
      expect(summary).toContain("[ready]");
      expect(summary).toContain("[single]");
      expect(summary).toContain("[cinematic]");
    });

    it("formats Chinese summary", () => {
      const state: ImageState = {
        recentImages: [makeImageResult()],
        maxHistory: 20,
      };

      const summary = getRecentImageSummary(state, "zh-CN");
      expect(summary).toContain("## 最近生成的插画");
      expect(summary).toContain("[已完成]");
      expect(summary).toContain("[单场景]");
    });

    it("shows multi-scene label", () => {
      const multiResult = makeImageResult({
        prompt: {
          original: "A battle scene",
          enhanced: "Enhanced battle",
          isMultiScene: true,
        },
      });
      const state: ImageState = {
        recentImages: [multiResult],
        maxHistory: 20,
      };

      const summary = getRecentImageSummary(state, "en-US");
      expect(summary).toContain("[multi-scene]");
    });

    it("respects limit parameter", () => {
      const results = Array.from({ length: 10 }, (_, i) =>
        makeImageResult({ imageId: `img-${i}` }),
      );
      const state: ImageState = { recentImages: results, maxHistory: 20 };

      const summary = getRecentImageSummary(state, "en-US", 3);
      const lines = summary.split("\n").filter((l) => l.startsWith("- "));
      expect(lines).toHaveLength(3);
    });
  });
});

// ── parseEnhancedResponse tests ─────────────────────────────────

describe("parseEnhancedResponse", () => {
  it("parses plain enhanced prompt", () => {
    const result = parseEnhancedResponse(
      "A forest scene",
      "A dark enchanted forest with twisted ancient oaks",
    );

    expect(result.original).toBe("A forest scene");
    expect(result.enhanced).toBe(
      "A dark enchanted forest with twisted ancient oaks",
    );
    expect(result.isMultiScene).toBe(false);
  });

  it("detects [MULTI-SCENE] prefix from LLM", () => {
    const result = parseEnhancedResponse(
      "A battle",
      "[MULTI-SCENE] Panel 1: The hero draws his sword. Panel 2: The dragon attacks.",
    );

    expect(result.isMultiScene).toBe(true);
    expect(result.multiSceneReason).toBe("llm-detected");
    expect(result.enhanced).toContain("Panel 1");
    expect(result.enhanced).not.toContain("[MULTI-SCENE]");
  });

  it("detects multi-scene via heuristic when LLM does not flag it", () => {
    const result = parseEnhancedResponse(
      "Meanwhile the villain escaped",
      "Enhanced prompt without multi-scene marker",
    );

    expect(result.isMultiScene).toBe(true);
    expect(result.multiSceneReason).toContain("meanwhile");
  });

  it("trims whitespace from response", () => {
    const result = parseEnhancedResponse(
      "scene",
      "  Enhanced prompt with spaces  \n",
    );

    expect(result.enhanced).toBe("Enhanced prompt with spaces");
  });
});

// ── Tool wrapper tests ──────────────────────────────────────────

describe("tools", () => {
  describe("requestStoryImageTool", () => {
    it("returns event.emit proposal with image.requested", async () => {
      const result = await requestStoryImageTool(
        makeToolCtx({
          storyBackground: "Medieval fantasy",
          scenePrompt: "The hero enters a dark cave",
        }),
      );

      expect(result.proposals).toHaveLength(1);
      expect(result.proposals![0].kind).toBe("event.emit");

      const payload = result.proposals![0].payload as Record<string, unknown>;
      expect(payload.type).toBe("image.requested");
      expect(payload.storyBackground).toBe("Medieval fantasy");
      expect(payload.scenePrompt).toBe("The hero enters a dark cave");
    });

    it("passes optional fields through", async () => {
      const result = await requestStoryImageTool(
        makeToolCtx({
          storyBackground: "Sci-fi world",
          scenePrompt: "Spaceship landing",
          continuityNotes: "Blue ship design",
          layoutPreference: "comic",
          stylePreset: "anime",
          negativePrompt: "no text",
        }),
      );

      const payload = result.proposals![0].payload as Record<string, unknown>;
      expect(payload.continuityNotes).toBe("Blue ship design");
      expect(payload.layoutPreference).toBe("comic");
      expect(payload.stylePreset).toBe("anime");
      expect(payload.negativePrompt).toBe("no text");
    });

    it("returns error for invalid input", async () => {
      const result = await requestStoryImageTool(
        makeToolCtx({ storyBackground: "test" }),
      );

      const output = result.output as Record<string, unknown>;
      expect(output.error).toBeDefined();
      expect(result.proposals).toBeUndefined();
    });

    it("returns zh-CN message for Chinese locale", async () => {
      const result = await requestStoryImageTool(
        makeToolCtx(
          {
            storyBackground: "中世纪幻想世界",
            scenePrompt: "英雄进入黑暗洞穴",
          },
          "zh-CN",
        ),
      );

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("已请求生成故事插画");
    });

    it("returns en message for English locale", async () => {
      const result = await requestStoryImageTool(
        makeToolCtx({
          storyBackground: "Fantasy",
          scenePrompt: "A dragon in the sky",
        }),
      );

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("Requested story image generation");
    });
  });
});

// ── Runtime handler tests ──────────────────────────────────────

describe("imageRuntimeHandler", () => {
  it("returns empty proposals when no image request in context", async () => {
    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "en-US",
      context: {},
    };

    const result = await imageRuntimeHandler(ctx);
    expect(result.proposals).toHaveLength(0);
  });

  it("produces state.patch and ui.render proposals with generateText", async () => {
    const mockGenerateText = vi.fn().mockResolvedValue(
      "A dramatic cinematic shot of a hero entering a dark cavern, torchlight casting long shadows on stalactite-covered walls, warm amber glow contrasting deep blue darkness",
    );

    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.requested",
          storyBackground: "Medieval fantasy world",
          scenePrompt: "The hero enters the cave",
          stylePreset: "cinematic",
        },
      },
      generateText: mockGenerateText,
    };

    const result = await imageRuntimeHandler(ctx);

    expect(mockGenerateText).toHaveBeenCalledOnce();
    expect(result.proposals).toHaveLength(2);

    const statePatch = result.proposals.find((p) => p.kind === "state.patch");
    expect(statePatch).toBeDefined();
    const statePayload = statePatch!.payload as Record<string, unknown>;
    expect(statePayload.scope).toBe("core-image");

    const uiRender = result.proposals.find((p) => p.kind === "ui.render");
    expect(uiRender).toBeDefined();
    const uiPayload = uiRender!.payload as Record<string, unknown>;
    expect(uiPayload.type).toBe("story_image");

    const data = uiPayload.data as Record<string, unknown>;
    expect(data.status).toBe("ready");
    expect(data.stylePreset).toBe("cinematic");
    expect(data.enhancedPrompt).toContain("dramatic cinematic shot");
    expect(data.originalPrompt).toBe("The hero enters the cave");
  });

  it("falls back to heuristic when generateText is not available", async () => {
    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.requested",
          storyBackground: "Fantasy world",
          scenePrompt: "A simple forest path",
        },
      },
    };

    const result = await imageRuntimeHandler(ctx);

    expect(result.proposals).toHaveLength(2);

    const uiRender = result.proposals.find((p) => p.kind === "ui.render");
    const data = (uiRender!.payload as Record<string, unknown>)
      .data as Record<string, unknown>;
    // Without LLM, enhanced = original
    expect(data.enhancedPrompt).toBe("A simple forest path");
    expect(data.originalPrompt).toBe("A simple forest path");
  });

  it("detects multi-scene from LLM response", async () => {
    const mockGenerateText = vi.fn().mockResolvedValue(
      "[MULTI-SCENE] Panel 1: Hero draws sword. Panel 2: Dragon breathes fire.",
    );

    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.requested",
          storyBackground: "Fantasy",
          scenePrompt: "Battle scene",
        },
      },
      generateText: mockGenerateText,
    };

    const result = await imageRuntimeHandler(ctx);

    const uiRender = result.proposals.find((p) => p.kind === "ui.render");
    const data = (uiRender!.payload as Record<string, unknown>)
      .data as Record<string, unknown>;
    expect(data.isMultiScene).toBe(true);
  });

  it("defaults style to cinematic when not specified", async () => {
    const mockGenerateText = vi.fn().mockResolvedValue("Enhanced prompt");

    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.requested",
          storyBackground: "World",
          scenePrompt: "Scene",
        },
      },
      generateText: mockGenerateText,
    };

    const result = await imageRuntimeHandler(ctx);

    const uiRender = result.proposals.find((p) => p.kind === "ui.render");
    const data = (uiRender!.payload as Record<string, unknown>)
      .data as Record<string, unknown>;
    expect(data.stylePreset).toBe("cinematic");
  });

  it("updates state with new image in recentImages", async () => {
    const mockGenerateText = vi.fn().mockResolvedValue("Enhanced");

    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.requested",
          storyBackground: "World",
          scenePrompt: "Scene",
        },
        state: {
          "core-image": {
            recentImages: [makeImageResult({ imageId: "old-1" })],
            maxHistory: 20,
          },
        },
      },
      generateText: mockGenerateText,
    };

    const result = await imageRuntimeHandler(ctx);

    const statePatch = result.proposals.find((p) => p.kind === "state.patch");
    const payload = statePatch!.payload as Record<string, unknown>;
    const patch = payload.patch as Record<string, unknown>;
    const recentImages = patch.recentImages as readonly ImageResult[];

    expect(recentImages).toHaveLength(2);
    // New image should be first
    expect(recentImages[0].imageId).not.toBe("old-1");
    expect(recentImages[1].imageId).toBe("old-1");
  });
});

// ── Context provider tests ──────────────────────────────────────

describe("imageContextProvider", () => {
  it("returns empty message for no images", async () => {
    const result = (await imageContextProvider({
      pluginId: "core-image",
      runtimeId: "image-generator",
      locale: "en-US",
      state: {},
    })) as Record<string, unknown>;

    expect(result.content).toBe("No images generated yet.");
    expect(result.priority).toBe(40);
  });

  it("returns image summary for existing images", async () => {
    const result = (await imageContextProvider({
      pluginId: "core-image",
      runtimeId: "image-generator",
      locale: "en-US",
      state: {
        "core-image": {
          recentImages: [makeImageResult()],
          maxHistory: 20,
        },
      },
    })) as Record<string, unknown>;

    expect((result.content as string)).toContain("[ready]");
    expect(result.id).toBe("image-history");
  });

  it("returns zh-CN content for Chinese locale", async () => {
    const result = (await imageContextProvider({
      pluginId: "core-image",
      runtimeId: "image-generator",
      locale: "zh-CN",
      state: {},
    })) as Record<string, unknown>;

    expect(result.title).toBe("最近生成的插画");
    expect(result.content).toBe("暂无已生成的插画。");
  });
});
