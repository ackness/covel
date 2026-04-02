import { describe, it, expect } from "vitest";
import {
  createCollectingRegistrar,
  createMockProviderInput,
} from "@covel/plugin-test-utils";
import register from "../server/index.js";
import {
  formatNarratorContext,
  type NarratorContextSection,
} from "../server/context-provider.js";

// ── Plugin Registration ─────────────────────────────────────────

describe("register", () => {
  it("registers a context provider and no runtime handler", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    register(registrar);

    expect(contributions.contextProviders.has("narrator-context")).toBe(true);
    expect(contributions.runtimeHandlers.size).toBe(0);
    expect(contributions.tools.size).toBe(0);
    expect(contributions.hooks.size).toBe(0);
    expect(contributions.commands).toHaveLength(0);
  });
});

// ── formatNarratorContext ────────────────────────────────────────

describe("formatNarratorContext", () => {
  it("includes world description when present", () => {
    const result = formatNarratorContext(
      undefined,
      { description: "A dark fantasy realm" },
      "en-US"
    );

    expect(result).toContain("[World Atmosphere]");
    expect(result).toContain("A dark fantasy realm");
  });

  it("includes world description in Chinese for zh locale", () => {
    const result = formatNarratorContext(
      undefined,
      { description: "黑暗奇幻世界" },
      "zh-CN"
    );

    expect(result).toContain("[世界氛围]");
    expect(result).toContain("黑暗奇幻世界");
  });

  it("includes tone from narrator state", () => {
    const result = formatNarratorContext(
      { tone: "mysterious and foreboding" },
      {},
      "en-US"
    );

    expect(result).toContain("[Narrative Tone]");
    expect(result).toContain("mysterious and foreboding");
  });

  it("includes last narrative summary", () => {
    const result = formatNarratorContext(
      { lastNarrative: "The hero entered the dark forest." },
      {},
      "en-US"
    );

    expect(result).toContain("[Latest Narrative Summary]");
    expect(result).toContain("The hero entered the dark forest.");
  });

  it("combines all sections when all data is present", () => {
    const result = formatNarratorContext(
      {
        lastNarrative: "Hero found the sword.",
        tone: "epic",
      },
      { description: "Fantasy realm" },
      "en-US"
    );

    expect(result).toContain("[World Atmosphere]");
    expect(result).toContain("Fantasy realm");
    expect(result).toContain("[Narrative Tone]");
    expect(result).toContain("epic");
    expect(result).toContain("[Latest Narrative Summary]");
    expect(result).toContain("Hero found the sword.");
  });

  it("returns empty string when no data is available", () => {
    const result = formatNarratorContext(undefined, {}, "en-US");

    expect(result).toBe("");
  });

  it("returns empty string for null world", () => {
    const result = formatNarratorContext(undefined, null, "en-US");

    expect(result).toBe("");
  });

  it("trims whitespace from values", () => {
    const result = formatNarratorContext(
      { tone: "  dramatic  " },
      {},
      "en-US"
    );

    expect(result).toContain("dramatic");
    expect(result).not.toContain("  dramatic  ");
  });

  it("skips empty string values", () => {
    const result = formatNarratorContext(
      { lastNarrative: "", tone: "" },
      { description: "" },
      "en-US"
    );

    expect(result).toBe("");
  });
});

// ── narratorContextProvider ─────────────────────────────────────

describe("narratorContextProvider", () => {
  it("returns structured context when narrator state exists", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("narrator-context")!;

    const input = createMockProviderInput({
      state: {
        narratorState: {
          lastNarrative: "勇者进入了黑暗森林。",
          tone: "神秘",
        },
      },
      world: { name: "测试世界", description: "一个充满魔法的世界" },
      locale: "zh-CN",
    });

    const result = (await provider(input)) as NarratorContextSection;

    expect(result).not.toBeNull();
    expect(result.title).toBe("Narrator Context");
    expect(result.priority).toBe(70);
    expect(result.content).toContain("勇者进入了黑暗森林。");
    expect(result.content).toContain("一个充满魔法的世界");
    expect(result.content).toContain("神秘");
  });

  it("returns context with only world description when no narrator state", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("narrator-context")!;

    const input = createMockProviderInput({
      state: {},
      world: { name: "Test World", description: "A vast open world" },
      locale: "en-US",
    });

    const result = (await provider(input)) as NarratorContextSection;

    expect(result).not.toBeNull();
    expect(result.content).toContain("A vast open world");
    expect(result.content).toContain("[World Atmosphere]");
  });

  it("returns null when state is empty and world has no description", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("narrator-context")!;

    const input = createMockProviderInput({
      state: {},
      world: { name: "Bare World" },
      locale: "en-US",
    });

    const result = await provider(input);

    expect(result).toBeNull();
  });

  it("returns null when state is undefined", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("narrator-context")!;

    const input = createMockProviderInput({
      state: undefined,
      world: {},
      locale: "en-US",
    });

    const result = await provider(input);

    expect(result).toBeNull();
  });

  it("handles narrator state with only lastNarrative", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("narrator-context")!;

    const input = createMockProviderInput({
      state: {
        narratorState: {
          lastNarrative: "The dragon flew overhead.",
        },
      },
      world: {},
      locale: "en-US",
    });

    const result = (await provider(input)) as NarratorContextSection;

    expect(result).not.toBeNull();
    expect(result.content).toContain("The dragon flew overhead.");
  });
});
