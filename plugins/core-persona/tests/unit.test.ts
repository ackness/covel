import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  createCollectingRegistrar,
  createMockProviderInput,
  createMockHandlerContext,
} from "@covel/plugin-test-utils";
import { validateManifest } from "@covel/plugin-runtime";
import register from "../server/index.js";

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
});

// ── Plugin Registration ─────────────────────────────────────────

describe("register", () => {
  it("registers a context provider and a runtime handler", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    register(registrar);

    expect(contributions.contextProviders.has("persona-context")).toBe(true);
    expect(contributions.runtimeHandlers.has("persona")).toBe(true);
    expect(contributions.tools.size).toBe(0);
    expect(contributions.hooks.size).toBe(0);
    expect(contributions.commands).toHaveLength(0);
  });
});

// ── Persona Runtime Handler (no-op) ────────────────────────────

describe("persona runtime handler", () => {
  it("returns empty proposals (no-op)", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("persona")!;
    const ctx = createMockHandlerContext();

    const result = await handler(ctx);

    expect(result.proposals).toEqual([]);
  });
});

// ── Persona Context Provider ───────────────────────────────────

describe("personaContextProvider", () => {
  it("returns narrator persona context with zh-CN locale", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("persona-context")!;

    const input = createMockProviderInput({
      locale: "zh-CN",
      world: { name: "测试世界", description: "一个奇幻世界" },
    });

    const result = (await provider(input)) as {
      id: string;
      title: string;
      content: string;
      priority: number;
    };

    expect(result.id).toBe("narrator-persona");
    expect(result.title).toContain("叙事人格");
    expect(result.content).toContain("沉浸式 RPG 叙事主持人");
    expect(result.content).toContain("绝不替玩家做决定");
    expect(result.content).toContain("测试世界");
    expect(result.priority).toBe(100);
  });

  it("returns narrator persona context with en-US locale", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("persona-context")!;

    const input = createMockProviderInput({
      locale: "en-US",
      world: { name: "Test World", description: "A fantasy world" },
    });

    const result = (await provider(input)) as {
      id: string;
      title: string;
      content: string;
      priority: number;
    };

    expect(result.id).toBe("narrator-persona");
    expect(result.title).toContain("Narrator persona");
    expect(result.content).toContain("immersive RPG narrative Game Master");
    expect(result.content).toContain("Never decide actions for the player");
    expect(result.content).toContain("Test World");
    expect(result.priority).toBe(100);
  });

  it("injects world lore when available (zh-CN)", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("persona-context")!;

    const input = createMockProviderInput({
      locale: "zh-CN",
      world: {
        name: "江湖世界",
        description: "一个武侠世界",
        lore: "这是一个门派林立的世界",
      },
    });

    const result = (await provider(input)) as {
      content: string;
    };

    expect(result.content).toContain("世界设定 (权威参考)");
    expect(result.content).toContain("这是一个门派林立的世界");
    expect(result.content).toContain("偏江湖传奇");
  });

  it("injects world lore when available (en-US)", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("persona-context")!;

    const input = createMockProviderInput({
      locale: "en-US",
      world: {
        name: "Martial World",
        description: "A wuxia martial arts world",
        lore: "A world of sects and martial honor",
      },
    });

    const result = (await provider(input)) as {
      content: string;
    };

    expect(result.content).toContain("World Setting (Authoritative Reference)");
    expect(result.content).toContain("A world of sects and martial honor");
    expect(result.content).toContain("Martial-world drama");
  });

  it("shows minimal world context when no lore is provided", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("persona-context")!;

    const input = createMockProviderInput({
      locale: "en-US",
      world: { name: "Cyberpunk City", description: "Neon-lit megacorp territory" },
    });

    const result = (await provider(input)) as {
      content: string;
    };

    expect(result.content).toContain("World: Cyberpunk City");
    expect(result.content).toContain("Neon-lit megacorp territory");
    expect(result.content).toContain("Hard cyberpunk");
  });

  it("infers cultivation style from world description", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("persona-context")!;

    const input = createMockProviderInput({
      locale: "zh-CN",
      world: { name: "灵气大陆", description: "一个修仙宗门遍布的世界" },
    });

    const result = (await provider(input)) as {
      content: string;
    };

    expect(result.content).toContain("偏修仙奇幻");
  });

  it("uses default adventure style for unrecognized worlds", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("persona-context")!;

    const input = createMockProviderInput({
      locale: "en-US",
      world: { name: "Unknown Land", description: "A mysterious place" },
    });

    const result = (await provider(input)) as {
      content: string;
    };

    expect(result.content).toContain("Compact adventure narration");
  });

  it("handles undefined world gracefully", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("persona-context")!;

    const input = createMockProviderInput({
      locale: "zh-CN",
      world: undefined,
    });

    const result = (await provider(input)) as {
      id: string;
      content: string;
    };

    expect(result.id).toBe("narrator-persona");
    expect(result.content).toContain("沉浸式 RPG 叙事主持人");
    // Default style when no world info
    expect(result.content).toContain("偏紧凑冒险叙事");
  });
});
