/**
 * Working Memory context injection tests.
 *
 * Verifies that:
 * - systemPrompt contains [Working Memory] block with correct ordering
 * - empty input emits no [Working Memory] block
 * - the segment appears before plugin instructions
 */

import { describe, it, expect } from "vitest";
import { buildContext } from "../src/context-builder.js";
import type { ContextBuildParams } from "../src/types.js";
import type { RuntimeManifest } from "@covel/shared";

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "test-runtime",
    pluginId: "test-plugin",
    pluginType: "plugin",
    description: "test",
    version: "0.0.1",
    runtimeType: "agent",
    trigger: { type: "auto" },
    tools: { builtin: [], plugin: [] },
    stage: "narrative",
    ...overrides,
  };
}

function makeParams(
  overrides?: Partial<ContextBuildParams>,
): ContextBuildParams {
  return {
    promptTemplate: "You are a narrator.",
    manifest: makeManifest(),
    turnInput: {
      sessionId: "sess-ctx",
      turnId: "turn-ctx",
      playerMessage: "Test",
      locale: undefined,
    },
    completedResults: new Map(),
    ...overrides,
  };
}

describe("Working Memory context injection", () => {
  it("entries present: systemPrompt contains [Working Memory] block", () => {
    const params = makeParams({
      workingMemory: [
        { scope: "player", key: "prefs", value: { theme: "dark" } },
        { scope: "story", key: "flags", value: ["started"] },
      ],
    });

    const ctx = buildContext(params);
    expect(ctx.systemPrompt).toContain("[Working Memory]");
    expect(ctx.systemPrompt).toContain("player.prefs:");
    expect(ctx.systemPrompt).toContain("story.flags:");
  });

  it("entries sorted player → story → shared, alphabetical key", () => {
    const params = makeParams({
      workingMemory: [
        { scope: "shared", key: "goal", value: "find artifact" },
        { scope: "player", key: "prefs", value: {} },
        { scope: "story", key: "flags", value: [] },
        { scope: "player", key: "avatar", value: "hero" },
      ],
    });

    const ctx = buildContext(params);
    const wmBlock =
      ctx.systemPrompt
        .split("\n\n")
        .find((seg) => seg.includes("[Working Memory]")) ?? "";
    const playerAvatarPos = wmBlock.indexOf("player.avatar:");
    const playerPrefsPos = wmBlock.indexOf("player.prefs:");
    const storyFlagsPos = wmBlock.indexOf("story.flags:");
    const sharedGoalPos = wmBlock.indexOf("shared.goal:");

    // player comes before story, story before shared
    expect(playerAvatarPos).toBeLessThan(storyFlagsPos);
    expect(playerPrefsPos).toBeLessThan(storyFlagsPos);
    expect(storyFlagsPos).toBeLessThan(sharedGoalPos);
    // alphabetical within player scope
    expect(playerAvatarPos).toBeLessThan(playerPrefsPos);
  });

  it("no entries: no [Working Memory] block rendered", () => {
    const params = makeParams({ workingMemory: [] });
    const ctx = buildContext(params);
    expect(ctx.systemPrompt).not.toContain("[Working Memory]");
  });

  it("workingMemory undefined: no [Working Memory] block rendered", () => {
    const params = makeParams({ workingMemory: undefined });
    const ctx = buildContext(params);
    expect(ctx.systemPrompt).not.toContain("[Working Memory]");
  });

  it("entries render JSON values", () => {
    const params = makeParams({
      workingMemory: [{ scope: "player", key: "persona", value: "warrior" }],
    });

    const ctx = buildContext(params);
    expect(ctx.systemPrompt).toContain("[Working Memory]");
    expect(ctx.systemPrompt).toContain("player.persona:");
    expect(ctx.systemPrompt).toContain('"warrior"');
  });

  // Working memory renders AFTER the plugin instructions. It changes every
  // turn, and ahead of the instructions it invalidated the largest block in
  // the prompt on every request — for explicit cache_control segments and for
  // automatic prefix caches alike. Trailing them also places the turn's
  // freshest state closest to the conversation.
  it("WM segment appears after plugin instructions", () => {
    const params = makeParams({
      promptTemplate: "You are a narrator.",
      workingMemory: [{ scope: "player", key: "k", value: 1 }],
    });

    const ctx = buildContext(params);
    const wmPos = ctx.systemPrompt.indexOf("[Working Memory]");
    const pluginPos = ctx.systemPrompt.indexOf("You are a narrator.");
    expect(wmPos).toBeGreaterThanOrEqual(0);
    expect(wmPos).toBeGreaterThan(pluginPos);
  });
});
