import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  createCollectingRegistrar,
  createMockProviderInput,
  createMockToolContext,
  findProposal,
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
  it("registers a tool and a context provider", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    register(registrar);

    expect(contributions.tools.has("generate-choices")).toBe(true);
    expect(contributions.contextProviders.has("guide-context")).toBe(true);
    expect(contributions.runtimeHandlers.size).toBe(0);
    expect(contributions.hooks.size).toBe(0);
    expect(contributions.commands).toHaveLength(0);
  });
});

// ── generateChoicesTool ─────────────────────────────────────────

describe("generateChoicesTool", () => {
  it("generates choices with custom options (zh-CN)", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-choices")!;

    const ctx = createMockToolContext({
      locale: "zh-CN",
      pluginId: "core-guide",
      input: {
        topic: "码头搜查方式",
        options: [
          { label: "假装工人混入" },
          { label: "贿赂守卫" },
          { label: "从水路潜入" },
        ],
      },
    });

    const result = await tool(ctx);

    expect(result.output.message).toContain("码头搜查方式");
    expect(result.output.message).toContain("3");
    expect(result.proposals).toHaveLength(1);

    const uiRender = findProposal<{
      type: string;
      content: { title: string; options: Array<{ id: string; label: string }> };
    }>(result.proposals!, "ui.render");

    expect(uiRender).toBeDefined();
    expect(uiRender!.type).toBe("choice_set");
    expect(uiRender!.content.options).toHaveLength(3);
    expect(uiRender!.content.options[0]!.id).toBe("opt_a");
    expect(uiRender!.content.options[0]!.label).toBe("假装工人混入");
    expect(uiRender!.content.options[2]!.id).toBe("opt_c");
  });

  it("generates choices with custom options that have explicit IDs", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-choices")!;

    const ctx = createMockToolContext({
      locale: "en-US",
      input: {
        topic: "response to guard",
        options: [
          { id: "bribe", label: "Offer a bribe" },
          { id: "fight", label: "Fight the guard" },
        ],
      },
    });

    const result = await tool(ctx);

    const uiRender = findProposal<{
      content: { options: Array<{ id: string; label: string }> };
    }>(result.proposals!, "ui.render");

    expect(uiRender!.content.options[0]!.id).toBe("bribe");
    expect(uiRender!.content.options[1]!.id).toBe("fight");
  });

  it("falls back to default zh-CN options when no options provided", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-choices")!;

    const ctx = createMockToolContext({
      locale: "zh-CN",
      input: { topic: "当前情况" },
    });

    const result = await tool(ctx);

    const uiRender = findProposal<{
      content: { options: Array<{ id: string; label: string }> };
    }>(result.proposals!, "ui.render");

    expect(uiRender!.content.options).toHaveLength(3);
    expect(uiRender!.content.options[0]!.label).toBe("谨慎行动");
    expect(uiRender!.content.options[1]!.label).toBe("大胆尝试");
    expect(uiRender!.content.options[2]!.label).toBe("先观察情况");
  });

  it("falls back to default en-US options when no options provided", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-choices")!;

    const ctx = createMockToolContext({
      locale: "en-US",
      input: { topic: "what to do next" },
    });

    const result = await tool(ctx);

    const uiRender = findProposal<{
      content: { options: Array<{ id: string; label: string }> };
    }>(result.proposals!, "ui.render");

    expect(uiRender!.content.options).toHaveLength(3);
    expect(uiRender!.content.options[0]!.label).toBe("Proceed cautiously");
    expect(uiRender!.content.options[1]!.label).toBe("Take a bold approach");
    expect(uiRender!.content.options[2]!.label).toBe("Observe first");
  });

  it("falls back to default topic when topic is not provided (zh-CN)", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-choices")!;

    const ctx = createMockToolContext({
      locale: "zh-CN",
      input: {},
    });

    const result = await tool(ctx);

    expect(result.output.message).toContain("当前情境");
  });

  it("falls back to default topic when topic is not provided (en-US)", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-choices")!;

    const ctx = createMockToolContext({
      locale: "en-US",
      input: {},
    });

    const result = await tool(ctx);

    expect(result.output.message).toContain("current situation");
  });

  it("falls back to defaults when options array is empty", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-choices")!;

    const ctx = createMockToolContext({
      locale: "en-US",
      input: { topic: "empty test", options: [] },
    });

    const result = await tool(ctx);

    const uiRender = findProposal<{
      content: { options: Array<{ id: string; label: string }> };
    }>(result.proposals!, "ui.render");

    expect(uiRender!.content.options).toHaveLength(3);
    expect(uiRender!.content.options[0]!.label).toBe("Proceed cautiously");
  });

  it("handles undefined input gracefully", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-choices")!;

    const ctx = createMockToolContext({
      locale: "zh-CN",
      input: undefined,
    });

    const result = await tool(ctx);

    expect(result.output.message).toContain("当前情境");
    expect(result.proposals).toHaveLength(1);
  });
});

// ── generateActionGuideTool ────────────────────────────────────

describe("generateActionGuideTool", () => {
  it("registers the action guide tool", () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    expect(contributions.tools.has("generate-action-guide")).toBe(true);
  });

  it("generates categorized suggestions (zh-CN)", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-action-guide")!;

    const ctx = createMockToolContext({
      locale: "zh-CN",
      pluginId: "core-guide",
      input: {
        topic: "码头搜查方式",
        categories: [
          { style: "safe", suggestions: ["先远处观察码头布局"] },
          { style: "aggressive", suggestions: ["直接闯入码头仓库"] },
          { style: "creative", suggestions: ["伪装成送货工人混入"] },
        ],
      },
    });

    const result = await tool(ctx);

    expect(result.output.message).toContain("码头搜查方式");
    expect(result.output.message).toContain("3 类");
    expect(result.output.message).toContain("3 条建议");
    expect(result.proposals).toHaveLength(1);

    const uiRender = findProposal<{
      type: string;
      content: {
        topic: string;
        categories: Array<{
          style: string;
          label: string;
          suggestions: string[];
        }>;
      };
    }>(result.proposals!, "ui.render");

    expect(uiRender).toBeDefined();
    expect(uiRender!.type).toBe("action_guide");
    expect(uiRender!.content.topic).toBe("码头搜查方式");
    expect(uiRender!.content.categories).toHaveLength(3);
    expect(uiRender!.content.categories[0]!.style).toBe("safe");
    expect(uiRender!.content.categories[0]!.label).toBe("稳妥");
    expect(uiRender!.content.categories[1]!.label).toBe("激进");
    expect(uiRender!.content.categories[2]!.label).toBe("创意");
  });

  it("generates categorized suggestions (en-US)", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-action-guide")!;

    const ctx = createMockToolContext({
      locale: "en-US",
      pluginId: "core-guide",
      input: {
        topic: "dock search approach",
        categories: [
          { style: "safe", suggestions: ["Scout the area first"] },
          { style: "wild", suggestions: ["Set the dock on fire as distraction"] },
        ],
      },
    });

    const result = await tool(ctx);

    expect(result.output.message).toContain("dock search approach");
    expect(result.output.message).toContain("2 categories");

    const uiRender = findProposal<{
      type: string;
      content: {
        categories: Array<{ style: string; label: string; suggestions: string[] }>;
      };
    }>(result.proposals!, "ui.render");

    expect(uiRender!.content.categories[0]!.label).toBe("Safe");
    expect(uiRender!.content.categories[1]!.label).toBe("Wild");
  });

  it("uses custom labels when provided", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-action-guide")!;

    const ctx = createMockToolContext({
      locale: "zh-CN",
      input: {
        topic: "战斗策略",
        categories: [
          { style: "safe", label: "防御为主", suggestions: ["举盾格挡"] },
          { style: "aggressive", label: "全力进攻", suggestions: ["冲锋斩击"] },
        ],
      },
    });

    const result = await tool(ctx);

    const uiRender = findProposal<{
      type: string;
      content: {
        categories: Array<{ label: string }>;
      };
    }>(result.proposals!, "ui.render");

    expect(uiRender!.content.categories[0]!.label).toBe("防御为主");
    expect(uiRender!.content.categories[1]!.label).toBe("全力进攻");
  });

  it("counts total suggestions across categories", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-action-guide")!;

    const ctx = createMockToolContext({
      locale: "en-US",
      input: {
        topic: "test",
        categories: [
          { style: "safe", suggestions: ["a", "b"] },
          { style: "creative", suggestions: ["c", "d", "e"] },
        ],
      },
    });

    const result = await tool(ctx);

    expect(result.output.message).toContain("5 suggestions");
    expect(result.output.message).toContain("2 categories");
  });

  it("returns error for invalid input (missing topic)", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-action-guide")!;

    const ctx = createMockToolContext({
      locale: "en-US",
      input: { categories: [{ style: "safe", suggestions: ["a"] }] },
    });

    const result = await tool(ctx);

    expect(result.output.error).toBeDefined();
    expect(result.proposals).toBeUndefined();
  });

  it("returns error for invalid input (empty categories)", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-action-guide")!;

    const ctx = createMockToolContext({
      locale: "en-US",
      input: { topic: "test", categories: [] },
    });

    const result = await tool(ctx);

    expect(result.output.error).toBeDefined();
  });

  it("returns error for invalid style value", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const tool = contributions.tools.get("generate-action-guide")!;

    const ctx = createMockToolContext({
      locale: "en-US",
      input: {
        topic: "test",
        categories: [{ style: "invalid", suggestions: ["a"] }],
      },
    });

    const result = await tool(ctx);

    expect(result.output.error).toBeDefined();
  });
});

// ── Guide Context Provider ──────────────────────────────────────

describe("guideContextProvider", () => {
  it("returns zh-CN guidance instructions", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("guide-context")!;

    const input = createMockProviderInput({ locale: "zh-CN", pluginId: "core-guide" });

    const result = (await provider(input)) as {
      id: string;
      title: string;
      content: string;
      priority: number;
    };

    expect(result.id).toBe("guide-instructions");
    expect(result.title).toContain("引导选择指令");
    expect(result.content).toContain("互动引导规则");
    expect(result.content).toContain("generate-choices");
    expect(result.content).toContain("generate-action-guide");
    expect(result.content).toContain("明确决策点");
    expect(result.priority).toBe(50);
  });

  it("returns en-US guidance instructions", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("guide-context")!;

    const input = createMockProviderInput({ locale: "en-US", pluginId: "core-guide" });

    const result = (await provider(input)) as {
      id: string;
      title: string;
      content: string;
      priority: number;
    };

    expect(result.id).toBe("guide-instructions");
    expect(result.title).toContain("Guide & Choices Instructions");
    expect(result.content).toContain("Guidance Rules");
    expect(result.content).toContain("generate-choices");
    expect(result.content).toContain("generate-action-guide");
    expect(result.content).toContain("Direct questions");
    expect(result.priority).toBe(50);
  });
});
