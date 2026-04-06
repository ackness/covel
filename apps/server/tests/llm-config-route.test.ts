import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createLlmConfigRoute } from "../src/routes/llm-config.js";
import type { LlmConfig, PresetConfig } from "@covel/ai-provider";

function makePreset(slotName: string, tag: string, overrides?: Partial<PresetConfig>): PresetConfig {
  return {
    id: `slot-${slotName}`,
    name: `${slotName} preset`,
    provider: "deepseek",
    protocol: "openai-chat-v1",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    tier: "medium",
    defaultSlot: slotName,
    supportedModes: ["text"],
    enabled: true,
    isDefault: false,
    tag,
    capability: {
      input: ["text"],
      output: ["text"],
      features: ["function_calling", "streaming"],
      contextWindow: 131072,
      maxOutputTokens: 8192,
    },
    ...overrides,
  };
}

function makeLlmConfig(slots: Record<string, { provider: string; model: string; protocol: string; tag?: string }>): LlmConfig {
  const result: Record<string, any> = {};
  for (const [name, def] of Object.entries(slots)) {
    result[name] = {
      provider: def.provider,
      model: def.model,
      baseUrl: "https://api.example.com",
      protocol: def.protocol,
      ...(def.tag ? { tag: def.tag } : {}),
    };
  }
  return { slots: result } as LlmConfig;
}

describe("GET /api/llm-config", () => {
  it("should include tag field for each slot", async () => {
    const llmConfig = makeLlmConfig({
      story: { provider: "deepseek", model: "deepseek-chat", protocol: "openai-chat-v1" },
      image: { provider: "openai", model: "dall-e-3", protocol: "openai-chat-v1", tag: "image" },
    });
    const presets = [
      makePreset("story", "text"),
      makePreset("image", "image"),
    ];

    const app = new Hono();
    app.route("/", createLlmConfigRoute(llmConfig, presets));

    const res = await app.request("/");
    const body = await res.json();

    expect(body.configured).toBe(true);
    expect(body.slots.story.tag).toBe("text");
    expect(body.slots.image.tag).toBe("image");
  });

  it("should default tag to 'text' when preset has no tag", async () => {
    const llmConfig = makeLlmConfig({
      utility: { provider: "dashscope", model: "qwen-turbo", protocol: "openai-chat-v1" },
    });
    // Preset without tag field
    const presets = [makePreset("utility", "text")];
    // Remove tag from preset to simulate missing
    delete (presets[0] as any).tag;

    const app = new Hono();
    app.route("/", createLlmConfigRoute(llmConfig, presets));

    const res = await app.request("/");
    const body = await res.json();

    // Should still have a tag, defaulting to "text"
    expect(body.slots.utility.tag).toBe("text");
  });

  it("should return empty slots with configured:false when no llmConfig", async () => {
    const app = new Hono();
    app.route("/", createLlmConfigRoute(null));

    const res = await app.request("/");
    const body = await res.json();

    expect(body.configured).toBe(false);
    expect(body.slots).toEqual({});
  });
});
