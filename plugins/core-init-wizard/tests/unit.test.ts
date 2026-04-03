import { describe, it, expect } from "vitest";
import {
  createCollectingRegistrar,
  createMockHandlerContext,
  findProposal,
} from "@covel/plugin-test-utils";
import register from "../server/index.js";
import {
  buildTransitionPrompt,
  buildFallbackTransition,
  buildCharacterCreationBlock,
} from "../server/logic.js";

// ── Plugin Registration ─────────────────────────────────────────

describe("register", () => {
  it("registers a runtime handler", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    register(registrar);

    expect(contributions.runtimeHandlers.has("init-wizard")).toBe(true);
    expect(contributions.tools.size).toBe(0);
    expect(contributions.hooks.size).toBe(0);
    expect(contributions.contextProviders.size).toBe(0);
    expect(contributions.commands).toHaveLength(0);
  });
});

// ── buildTransitionPrompt ──────────────────────────────────────

describe("buildTransitionPrompt", () => {
  it("builds a Chinese prompt for zh-CN locale", async () => {
    const prompt = await buildTransitionPrompt("勇者走进了迷雾森林", "zh-CN");

    expect(prompt).toContain("RPG游戏的角色创建引导者");
    expect(prompt).toContain("勇者走进了迷雾森林");
    expect(prompt).toContain("你叫什么名字");
    expect(prompt).toContain("第二人称");
  });

  it("builds an English prompt for en-US locale", async () => {
    const prompt = await buildTransitionPrompt("The hero entered the fog.", "en-US");

    expect(prompt).toContain("RPG character creation guide");
    expect(prompt).toContain("The hero entered the fog.");
    expect(prompt).toContain("what is your name");
    expect(prompt).toContain("second person");
  });

  it("treats zh-TW as Chinese", async () => {
    const prompt = await buildTransitionPrompt("Test narrative", "zh-TW");

    expect(prompt).toContain("RPG游戏的角色创建引导者");
  });
});

// ── buildFallbackTransition ────────────────────────────────────

describe("buildFallbackTransition", () => {
  it("returns Chinese fallback for zh-CN", () => {
    const text = buildFallbackTransition("zh-CN");

    expect(text).toBe("在这一切开始之前——你叫什么名字？");
  });

  it("returns English fallback for en-US", () => {
    const text = buildFallbackTransition("en-US");

    expect(text).toBe("Before all this begins — what is your name?");
  });

  it("returns Chinese fallback for zh-TW", () => {
    const text = buildFallbackTransition("zh-TW");

    expect(text).toContain("你叫什么名字");
  });
});

// ── buildCharacterCreationBlock ────────────────────────────────

describe("buildCharacterCreationBlock", () => {
  it("builds zh-CN character creation block", () => {
    const block = buildCharacterCreationBlock("zh-CN");

    expect(block.kind).toBe("ui.render");

    const payload = block.payload as {
      type: string;
      content: {
        fields: Array<{
          id: string;
          type: string;
          label: string;
          placeholder: string;
          required: boolean;
        }>;
        submitLabel: string;
        submitMapping: Record<string, string>;
      };
    };

    expect(payload.type).toBe("character_creation");
    expect(payload.content.fields).toHaveLength(1);
    expect(payload.content.fields[0]!.id).toBe("character_name");
    expect(payload.content.fields[0]!.type).toBe("text");
    expect(payload.content.fields[0]!.label).toBe("你的名字");
    expect(payload.content.fields[0]!.placeholder).toContain("键入");
    expect(payload.content.fields[0]!.required).toBe(true);
    expect(payload.content.submitLabel).toBe("确认");
    expect(payload.content.submitMapping.character_name).toBe("name");
  });

  it("builds en-US character creation block", () => {
    const block = buildCharacterCreationBlock("en-US");

    const payload = block.payload as {
      type: string;
      content: {
        fields: Array<{ label: string; placeholder: string }>;
        submitLabel: string;
      };
    };

    expect(payload.content.fields[0]!.label).toBe("Your Name");
    expect(payload.content.fields[0]!.placeholder).toContain("Type your name");
    expect(payload.content.submitLabel).toBe("Confirm");
  });
});

// ── initWizardHandler ──────────────────────────────────────────

describe("initWizardHandler", () => {
  it("uses LLM transition when generateText and narrative are available", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("init-wizard")!;

    const ctx = createMockHandlerContext({
      contextOverrides: {
        locale: "zh-CN",
      },
      generateTextImpl: async () => "雾气中传来低沉的钟声，你不由得停下脚步——你，叫什么名字？",
    });

    // Inject previousOutputs into context
    const ctxWithNarrative = {
      ...ctx,
      context: {
        ...ctx.context,
        previousOutputs: [{ narrative: "迷雾笼罩着港口" }],
      },
    };

    const result = await handler(ctxWithNarrative);

    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0]!.kind).toBe("narrative.append");

    const narrativePayload = result.proposals[0]!.payload as { text: string };
    expect(narrativePayload.text).toContain("钟声");

    expect(result.proposals[1]!.kind).toBe("ui.render");
  });

  it("falls back to static transition when generateText is not available", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("init-wizard")!;

    const ctx = createMockHandlerContext({
      contextOverrides: { locale: "zh-CN" },
    });

    const ctxWithoutLLM = { ...ctx, generateText: undefined };

    const result = await handler(ctxWithoutLLM);

    expect(result.proposals).toHaveLength(2);

    const narrativePayload = result.proposals[0]!.payload as { text: string };
    expect(narrativePayload.text).toBe("在这一切开始之前——你叫什么名字？");
  });

  it("falls back to static transition when no opening narrative exists", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("init-wizard")!;

    const ctx = createMockHandlerContext({
      contextOverrides: { locale: "en-US" },
      generateTextImpl: async () => "should not be called",
    });

    // No previousOutputs in context
    const result = await handler(ctx);

    expect(result.proposals).toHaveLength(2);

    const narrativePayload = result.proposals[0]!.payload as { text: string };
    expect(narrativePayload.text).toBe("Before all this begins — what is your name?");
  });

  it("falls back to static transition when LLM throws an error", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("init-wizard")!;

    const ctx = createMockHandlerContext({
      contextOverrides: { locale: "en-US" },
      generateTextImpl: async () => {
        throw new Error("LLM unavailable");
      },
    });

    const ctxWithNarrative = {
      ...ctx,
      context: {
        ...ctx.context,
        previousOutputs: [{ narrative: "Some opening narrative" }],
      },
    };

    const result = await handler(ctxWithNarrative);

    expect(result.proposals).toHaveLength(2);

    const narrativePayload = result.proposals[0]!.payload as { text: string };
    expect(narrativePayload.text).toBe("Before all this begins — what is your name?");
  });

  it("falls back when LLM returns empty string", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("init-wizard")!;

    const ctx = createMockHandlerContext({
      contextOverrides: { locale: "zh-CN" },
      generateTextImpl: async () => "   ",
    });

    const ctxWithNarrative = {
      ...ctx,
      context: {
        ...ctx.context,
        previousOutputs: [{ narrative: "开场叙事" }],
      },
    };

    const result = await handler(ctxWithNarrative);

    const narrativePayload = result.proposals[0]!.payload as { text: string };
    expect(narrativePayload.text).toBe("在这一切开始之前——你叫什么名字？");
  });

  it("always emits narrative.append and ui.render proposals", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("init-wizard")!;

    const ctx = createMockHandlerContext({
      contextOverrides: { locale: "en-US" },
    });

    const result = await handler({ ...ctx, generateText: undefined });

    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0]!.kind).toBe("narrative.append");
    expect(result.proposals[1]!.kind).toBe("ui.render");

    const uiPayload = result.proposals[1]!.payload as {
      type: string;
      content: { fields: unknown[] };
    };
    expect(uiPayload.type).toBe("character_creation");
    expect(uiPayload.content.fields).toHaveLength(1);
  });

  it("concatenates multiple previous narrative outputs", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const handler = contributions.runtimeHandlers.get("init-wizard")!;

    const customTransition = "从码头的雾气中走来一个身影——你是谁？";

    const ctx = createMockHandlerContext({
      contextOverrides: { locale: "zh-CN" },
      generateTextImpl: async () => customTransition,
    });

    const ctxWithMultipleOutputs = {
      ...ctx,
      context: {
        ...ctx.context,
        previousOutputs: [
          { narrative: "Part 1 of the story." },
          { narrative: "Part 2 continues." },
        ],
      },
    };

    const result = await handler(ctxWithMultipleOutputs);

    const narrativePayload = result.proposals[0]!.payload as { text: string };
    expect(narrativePayload.text).toBe(customTransition);
  });
});
