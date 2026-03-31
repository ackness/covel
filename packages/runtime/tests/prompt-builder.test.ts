import { describe, it, expect } from "vitest";
import { buildPrompt } from "../src/prompt-builder.js";
import type { RuntimeContextView } from "@covel/shared";

function makeContext(
  overrides: Partial<RuntimeContextView> = {}
): RuntimeContextView {
  return {
    run: {
      runId: "run-1",
      branchId: "branch-1",
      turnId: "turn-1",
    },
    locale: "zh-CN",
    runtime: {
      runtimeId: "rt-1",
      pluginId: "plugin-1",
      kind: "story",
      phase: "story",
      allowedTools: [],
    },
    ...overrides,
  };
}

describe("prompt-builder", () => {
  it("builds a basic prompt with instructions", () => {
    const ctx = makeContext();
    const messages = buildPrompt(ctx, {
      instructions: "You are a storyteller.",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("You are a storyteller.");
    expect(messages[0].content).toContain("[Locale: zh-CN]");
  });

  it("includes world context", () => {
    const ctx = makeContext({
      world: { name: "Fantasy World", era: "Medieval" },
    });
    const messages = buildPrompt(ctx, {
      instructions: "Narrate.",
    });

    expect(messages[0].content).toContain("<world>");
    expect(messages[0].content).toContain("Fantasy World");
  });

  it("includes character context", () => {
    const ctx = makeContext({
      characters: [{ name: "Hero", class: "Warrior" }],
    });
    const messages = buildPrompt(ctx);

    expect(messages[0].content).toContain("<characters>");
    expect(messages[0].content).toContain("Hero");
  });

  it("includes chat history", () => {
    const ctx = makeContext({
      chat: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    });
    const messages = buildPrompt(ctx);

    // System message + 2 chat messages
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(messages[2]).toEqual({ role: "assistant", content: "Hi there!" });
  });

  it("appends narrative as last assistant message", () => {
    const ctx = makeContext({
      narrative: { content: "The hero stood at the gate." },
    });
    const messages = buildPrompt(ctx);

    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("The hero stood at the gate.");
  });

  it("returns empty when no context or instructions", () => {
    const ctx = makeContext();
    const messages = buildPrompt(ctx);

    // Only system message with locale
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("[Locale: zh-CN]");
  });
});
