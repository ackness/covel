import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { validateManifest } from "@covel/plugin-runtime";
import {
  buildEnhancePromptEn,
  buildEnhancePromptZh,
  detectMultiScene,
  addImageResult,
  getRecentImageSummary,
  resolvePromptLanguage,
  EMPTY_STATE,
  DEFAULT_SETTINGS,
  type ImageRequest,
  type ImageResult,
  type ImageState,
  type ImageSettings,
} from "../server/image-logic.js";
import {
  promptEnhancerHandler,
  imageGeneratorHandler,
  imageRuntimeHandler,
  settingsUpdaterHandler,
  parseEnhancedResponse,
} from "../server/runtime-handler.js";
import { imageContextProvider } from "../server/context-provider.js";
import type { RuntimeHandlerContext } from "@covel/plugin-runtime";

// ── plugin.json manifest ────────────────────────────────────────

describe("plugin.json manifest", () => {
  it("passes schema validation", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const result = validateManifest(raw);
    if (!result.ok) {
      throw new Error(
        `Manifest validation failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
    expect(result.ok).toBe(true);
  });

  it("has two runtimes: image-generator and settings-updater", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const runtimeIds = raw.runtimes.map((r: { id: string }) => r.id);
    expect(runtimeIds).toContain("image-generator");
    expect(runtimeIds).toContain("settings-updater");
  });

  it("image-generator uses text providerTag so the handler can enhance prompts before rendering", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const generator = raw.runtimes.find((r: { id: string }) => r.id === "image-generator");
    expect(generator?.providerTag).toBe("text");
  });

  it("settings-updater does not require an LLM slot", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const updater = raw.runtimes.find((r: { id: string }) => r.id === "settings-updater");
    expect(updater?.providerTag).toBeUndefined();
  });

  it("has core_image_settings blockSchema for settings_panel", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const settingsSchema = raw.blockSchemas?.find(
      (s: { type: string }) => s.type === "core_image_settings",
    );
    expect(settingsSchema).toBeDefined();
  });

  it("does not expose any auto-trigger image generation tool", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    expect(raw.tools).toEqual([]);
  });
});

// ── Helpers ──────────────────────────────────────────────────

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
  describe("buildEnhancePromptEn", () => {
    it("includes story background and scene prompt", () => {
      const result = buildEnhancePromptEn(makeRequest());
      expect(result).toContain("A medieval fantasy world");
      expect(result).toContain("The hero enters the dark cave");
    });

    it("includes style preset", () => {
      const result = buildEnhancePromptEn(makeRequest({ stylePreset: "anime" }));
      expect(result).toContain("anime");
    });

    it("defaults style to cinematic", () => {
      const result = buildEnhancePromptEn(makeRequest());
      expect(result).toContain("cinematic");
    });

    it("includes world context when provided", () => {
      const result = buildEnhancePromptEn(
        makeRequest(),
        "The kingdom of Eldoria, a land of magic and dragons",
      );
      expect(result).toContain("Eldoria");
    });

    it("includes characters when provided", () => {
      const result = buildEnhancePromptEn(
        makeRequest(),
        undefined,
        "Aria: tall elf with silver hair",
      );
      expect(result).toContain("Aria");
    });

    it("includes continuity notes when provided", () => {
      const result = buildEnhancePromptEn(
        makeRequest({ continuityNotes: "Previous scene had warm sunset tones" }),
      );
      expect(result).toContain("warm sunset tones");
    });

    it("includes negative prompt when provided", () => {
      const result = buildEnhancePromptEn(
        makeRequest({ negativePrompt: "no gore, no blood" }),
      );
      expect(result).toContain("no gore, no blood");
    });

    it("adds no-text instruction when includeText is false", () => {
      const result = buildEnhancePromptEn(
        makeRequest(),
        undefined,
        undefined,
        { ...DEFAULT_SETTINGS, includeText: false },
      );
      expect(result).toMatch(/no text|avoid.*text|without.*text/i);
    });

    it("adds multi-panel instruction when multiPanel is true", () => {
      const result = buildEnhancePromptEn(
        makeRequest(),
        undefined,
        undefined,
        { ...DEFAULT_SETTINGS, multiPanel: true },
      );
      expect(result).toMatch(/multi.panel|comic|panel/i);
    });
  });

  describe("buildEnhancePromptZh", () => {
    it("returns Chinese instructions", () => {
      const result = buildEnhancePromptZh(makeRequest());
      expect(result).toMatch(/[\u4e00-\u9fff]/); // has Chinese characters
    });

    it("includes story background", () => {
      const result = buildEnhancePromptZh(makeRequest({ storyBackground: "中世纪幻想" }));
      expect(result).toContain("中世纪幻想");
    });

    it("adds no-text instruction in Chinese when includeText is false", () => {
      const result = buildEnhancePromptZh(
        makeRequest(),
        undefined,
        undefined,
        { ...DEFAULT_SETTINGS, includeText: false },
      );
      expect(result).toMatch(/不.*文字|无.*文字|避免.*文字/);
    });
  });

  describe("resolvePromptLanguage", () => {
    it("returns zh for auto with zh locale", () => {
      const lang = resolvePromptLanguage(
        { ...DEFAULT_SETTINGS, promptLanguage: "auto" },
        "zh-CN",
      );
      expect(lang).toBe("zh");
    });

    it("returns en for auto with en locale", () => {
      const lang = resolvePromptLanguage(
        { ...DEFAULT_SETTINGS, promptLanguage: "auto" },
        "en-US",
      );
      expect(lang).toBe("en");
    });

    it("respects explicit zh override", () => {
      const lang = resolvePromptLanguage(
        { ...DEFAULT_SETTINGS, promptLanguage: "zh" },
        "en-US",
      );
      expect(lang).toBe("zh");
    });

    it("respects explicit en override", () => {
      const lang = resolvePromptLanguage(
        { ...DEFAULT_SETTINGS, promptLanguage: "en" },
        "zh-CN",
      );
      expect(lang).toBe("en");
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

    it("detects 'cut to' keyword", () => {
      const result = detectMultiScene("Cut to the interior of the castle.");
      expect(result.isMultiScene).toBe(true);
    });

    it("detects dialogue patterns", () => {
      const result = detectMultiScene('「你好」她说。「很高兴认识你」他回答。');
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

    it("returns false for simple scene", () => {
      const result = detectMultiScene("A beautiful sunset over the mountains.");
      expect(result.isMultiScene).toBe(false);
    });
  });

  describe("addImageResult", () => {
    it("adds result to the beginning of recentImages", () => {
      const existing = makeImageResult({ imageId: "existing-1" });
      const state: ImageState = { recentImages: [existing], maxHistory: 20, settings: DEFAULT_SETTINGS };
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
      const state: ImageState = { recentImages: results, maxHistory: 3, settings: DEFAULT_SETTINGS };
      const newResult = makeImageResult({ imageId: "new-1" });

      const updated = addImageResult(state, newResult);

      expect(updated.recentImages).toHaveLength(3);
      expect(updated.recentImages[0].imageId).toBe("new-1");
    });

    it("does not mutate original state", () => {
      const original: ImageState = { recentImages: [], maxHistory: 20, settings: DEFAULT_SETTINGS };
      const newResult = makeImageResult();

      const updated = addImageResult(original, newResult);

      expect(original.recentImages).toHaveLength(0);
      expect(updated.recentImages).toHaveLength(1);
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
        settings: DEFAULT_SETTINGS,
      };
      const summary = getRecentImageSummary(state, "en-US");
      expect(summary).toContain("## Recent Images");
      expect(summary).toContain("[ready]");
      expect(summary).toContain("[cinematic]");
    });

    it("formats Chinese summary", () => {
      const state: ImageState = {
        recentImages: [makeImageResult()],
        maxHistory: 20,
        settings: DEFAULT_SETTINGS,
      };
      const summary = getRecentImageSummary(state, "zh-CN");
      expect(summary).toContain("## 最近生成的插画");
      expect(summary).toContain("[已完成]");
    });

    it("respects limit parameter", () => {
      const results = Array.from({ length: 10 }, (_, i) =>
        makeImageResult({ imageId: `img-${i}` }),
      );
      const state: ImageState = { recentImages: results, maxHistory: 20, settings: DEFAULT_SETTINGS };
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
    expect(result.enhanced).toBe("A dark enchanted forest with twisted ancient oaks");
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
    const result = parseEnhancedResponse("scene", "  Enhanced prompt  \n");
    expect(result.enhanced).toBe("Enhanced prompt");
  });
});

// ── promptEnhancerHandler tests ─────────────────────────────────

describe("promptEnhancerHandler", () => {
  it("returns empty proposals when no image.generation.requested event in context", async () => {
    const ctx: RuntimeHandlerContext = {
      runtimeId: "prompt-enhancer",
      pluginId: "core-image",
      locale: "en-US",
      context: {},
    };
    const result = await promptEnhancerHandler(ctx);
    expect(result.proposals).toHaveLength(0);
  });

  it("emits image.generation.ready with enhanced prompt (en)", async () => {
    const mockGenerateText = vi.fn().mockResolvedValue(
      "A dramatic cinematic shot of a hero entering a dark cavern",
    );

    const ctx: RuntimeHandlerContext = {
      runtimeId: "prompt-enhancer",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.generation.requested",
          storyBackground: "Medieval fantasy world",
          scenePrompt: "The hero enters the cave",
          stylePreset: "cinematic",
        },
      },
      generateText: mockGenerateText,
    };

    const result = await promptEnhancerHandler(ctx);

    expect(result.proposals).toHaveLength(1);
    const emitProposal = result.proposals.find((p) => p.kind === "event.emit");
    expect(emitProposal).toBeDefined();

    const payload = emitProposal!.payload as Record<string, unknown>;
    expect(payload.type).toBe("image.generation.ready");
    const eventPayload = payload.payload as Record<string, unknown>;
    expect(eventPayload.enhancedPrompt).toContain("dramatic cinematic shot");
    expect(eventPayload.style).toBe("cinematic");
  });

  it("emits image.generation.ready with zh prompt when locale is zh-CN", async () => {
    const mockGenerateText = vi.fn().mockResolvedValue(
      "一位英雄进入漆黑洞穴，火把照亮钟乳石，戏剧性光影效果",
    );

    const ctx: RuntimeHandlerContext = {
      runtimeId: "prompt-enhancer",
      pluginId: "core-image",
      locale: "zh-CN",
      context: {
        event: {
          type: "image.generation.requested",
          storyBackground: "中世纪幻想世界",
          scenePrompt: "英雄进入洞穴",
        },
        state: {
          "core-image": {
            recentImages: [],
            maxHistory: 20,
            settings: DEFAULT_SETTINGS,
          },
        },
      },
      generateText: mockGenerateText,
    };

    const result = await promptEnhancerHandler(ctx);
    const emitProposal = result.proposals.find((p) => p.kind === "event.emit");
    const payload = emitProposal!.payload as Record<string, unknown>;
    const eventPayload = payload.payload as Record<string, unknown>;
    expect(eventPayload.enhancedPrompt).toMatch(/[\u4e00-\u9fff]/); // Chinese
  });

  it("includes referenceUrl when recent images exist", async () => {
    const mockGenerateText = vi.fn().mockResolvedValue("Enhanced");

    const recentImage = makeImageResult({ imageUrl: "https://cdn.example.com/prev.png" });
    const ctx: RuntimeHandlerContext = {
      runtimeId: "prompt-enhancer",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.generation.requested",
          storyBackground: "World",
          scenePrompt: "Scene",
        },
        state: {
          "core-image": {
            recentImages: [recentImage],
            maxHistory: 20,
            settings: DEFAULT_SETTINGS,
          },
        },
      },
      generateText: mockGenerateText,
    };

    const result = await promptEnhancerHandler(ctx);
    const emitProposal = result.proposals.find((p) => p.kind === "event.emit");
    const payload = emitProposal!.payload as Record<string, unknown>;
    const eventPayload = payload.payload as Record<string, unknown>;
    expect(eventPayload.referenceUrl).toBe("https://cdn.example.com/prev.png");
  });

  it("passes settings from state to the ready event", async () => {
    const mockGenerateText = vi.fn().mockResolvedValue("Enhanced");
    const customSettings: ImageSettings = {
      style: "anime",
      multiPanel: true,
      includeText: false,
      promptLanguage: "en",
    };

    const ctx: RuntimeHandlerContext = {
      runtimeId: "prompt-enhancer",
      pluginId: "core-image",
      locale: "zh-CN",
      context: {
        event: {
          type: "image.generation.requested",
          storyBackground: "World",
          scenePrompt: "Scene",
        },
        state: {
          "core-image": {
            recentImages: [],
            maxHistory: 20,
            settings: customSettings,
          },
        },
      },
      generateText: mockGenerateText,
    };

    const result = await promptEnhancerHandler(ctx);
    const emitProposal = result.proposals.find((p) => p.kind === "event.emit");
    const payload = emitProposal!.payload as Record<string, unknown>;
    const eventPayload = payload.payload as Record<string, unknown>;
    expect(eventPayload.style).toBe("anime");
    expect((eventPayload.settings as ImageSettings).multiPanel).toBe(true);
  });
});

// ── imageGeneratorHandler tests ──────────────────────────────────

describe("imageGeneratorHandler", () => {
  it("returns empty proposals when no image.generation.ready event in context", async () => {
    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "en-US",
      context: {},
    };
    const result = await imageGeneratorHandler(ctx);
    expect(result.proposals).toHaveLength(0);
  });

  it("calls generateImage with enhanced prompt and emits ui.render + state.patch", async () => {
    const mockGenerateImage = vi.fn().mockResolvedValue({
      url: "https://cdn.example.com/generated.png",
    });

    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.generation.ready",
          enhancedPrompt: "A dramatic cinematic shot of a hero",
          style: "cinematic",
          settings: DEFAULT_SETTINGS,
        },
      },
      generateImage: mockGenerateImage,
    };

    const result = await imageGeneratorHandler(ctx);

    expect(mockGenerateImage).toHaveBeenCalledOnce();
    expect(mockGenerateImage).toHaveBeenCalledWith(
      "A dramatic cinematic shot of a hero",
      expect.objectContaining({ providerRequestMetadata: expect.any(Object) }),
    );

    expect(result.proposals).toHaveLength(2);

    const uiRender = result.proposals.find((p) => p.kind === "ui.render");
    expect(uiRender).toBeDefined();
    const data = (uiRender!.payload as Record<string, unknown>).content as Record<string, unknown>;
    expect(data.imageUrl).toBe("https://cdn.example.com/generated.png");
    expect(data.status).toBe("ready");
    expect(data.stylePreset).toBe("cinematic");

    const statePatch = result.proposals.find((p) => p.kind === "state.patch");
    expect(statePatch).toBeDefined();
  });

  it("passes referenceUrl to generateImage when provided", async () => {
    const mockGenerateImage = vi.fn().mockResolvedValue({ url: "https://cdn.example.com/new.png" });

    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.generation.ready",
          enhancedPrompt: "Enhanced scene",
          style: "cinematic",
          referenceUrl: "https://cdn.example.com/prev.png",
          settings: DEFAULT_SETTINGS,
        },
      },
      generateImage: mockGenerateImage,
    };

    await imageGeneratorHandler(ctx);
    expect(mockGenerateImage).toHaveBeenCalledWith(
      "Enhanced scene",
      expect.objectContaining({ referenceUrl: "https://cdn.example.com/prev.png" }),
    );
  });

  it("emits error status ui.render when generateImage throws", async () => {
    const mockGenerateImage = vi.fn().mockRejectedValue(new Error("API error"));

    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.generation.ready",
          enhancedPrompt: "Test prompt",
          style: "cinematic",
          settings: DEFAULT_SETTINGS,
        },
      },
      generateImage: mockGenerateImage,
    };

    const result = await imageGeneratorHandler(ctx);
    const uiRender = result.proposals.find((p) => p.kind === "ui.render");
    const data = (uiRender!.payload as Record<string, unknown>).content as Record<string, unknown>;
    expect(data.status).toBe("error");
    expect(data.error).toContain("API error");
  });

  it("emits error status when generateImage is not available", async () => {
    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.generation.ready",
          enhancedPrompt: "Test prompt",
          style: "cinematic",
          settings: DEFAULT_SETTINGS,
        },
      },
      // No generateImage injected
    };

    const result = await imageGeneratorHandler(ctx);
    const uiRender = result.proposals.find((p) => p.kind === "ui.render");
    const data = (uiRender!.payload as Record<string, unknown>).content as Record<string, unknown>;
    expect(data.status).toBe("error");
  });
});

describe("imageRuntimeHandler", () => {
  it("runs prompt enhancement and image generation in a single handler", async () => {
    const mockGenerateText = vi.fn().mockResolvedValue("Enhanced hero scene");
    const mockGenerateImage = vi.fn().mockResolvedValue({
      url: "https://cdn.example.com/final.png",
    });

    const ctx: RuntimeHandlerContext = {
      runtimeId: "image-generator",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.generation.requested",
          storyBackground: "World",
          scenePrompt: "Hero scene",
        },
        state: {
          "core-image": {
            recentImages: [],
            maxHistory: 20,
            settings: DEFAULT_SETTINGS,
          },
        },
      },
      generateText: mockGenerateText,
      generateImage: mockGenerateImage,
    };

    const result = await imageRuntimeHandler(ctx);
    expect(mockGenerateText).toHaveBeenCalledOnce();
    expect(mockGenerateImage).toHaveBeenCalledOnce();
    expect(result.proposals.some((p) => p.kind === "ui.render")).toBe(true);
    expect(result.proposals.some((p) => p.kind === "state.patch")).toBe(true);
  });
});

describe("settingsUpdaterHandler", () => {
  it("patches core-image settings from image.settings.updated events", async () => {
    const result = await settingsUpdaterHandler({
      runtimeId: "settings-updater",
      pluginId: "core-image",
      locale: "en-US",
      context: {
        event: {
          type: "image.settings.updated",
          settings: {
            style: "anime",
            multiPanel: true,
            includeText: true,
            promptLanguage: "en",
          },
        },
      },
    });

    expect(result.proposals).toEqual([
      {
        kind: "state.patch",
        payload: {
          "core-image": {
            settings: {
              style: "anime",
              multiPanel: true,
              includeText: true,
              promptLanguage: "en",
            },
          },
        },
      },
    ]);
  });
});

// ── Context provider tests ──────────────────────────────────────

describe("imageContextProvider", () => {
  it("returns empty message for no images", async () => {
    const result = (await imageContextProvider({
      pluginId: "core-image",
      runtimeId: "prompt-enhancer",
      locale: "en-US",
      state: {},
    })) as Record<string, unknown>;

    expect(result.content).toBe("No images generated yet.");
    expect(result.priority).toBe(40);
  });

  it("returns image summary for existing images", async () => {
    const result = (await imageContextProvider({
      pluginId: "core-image",
      runtimeId: "prompt-enhancer",
      locale: "en-US",
      state: {
        "core-image": {
          recentImages: [makeImageResult()],
          maxHistory: 20,
          settings: DEFAULT_SETTINGS,
        },
      },
    })) as Record<string, unknown>;

    expect((result.content as string)).toContain("[ready]");
    expect(result.id).toBe("image-history");
  });

  it("returns zh-CN content for Chinese locale", async () => {
    const result = (await imageContextProvider({
      pluginId: "core-image",
      runtimeId: "prompt-enhancer",
      locale: "zh-CN",
      state: {},
    })) as Record<string, unknown>;

    expect(result.title).toBe("最近生成的插画");
    expect(result.content).toBe("暂无已生成的插画。");
  });
});
