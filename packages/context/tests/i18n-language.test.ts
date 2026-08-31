import { describe, expect, it } from "vitest";
import {
  buildCurrentTurnUserMessage,
  renderCoreMemory,
  resolveLocaleLanguageName,
} from "../src/prompt-internals.js";

describe("prompt locale normalization", () => {
  it("uses the shared language subtag for prompt variants", () => {
    expect(
      buildCurrentTurnUserMessage({
        playerMessage: "",
        locale: "ZH_cn",
      }),
    ).toContain("开始当前游戏回合");
    expect(resolveLocaleLanguageName("en_GB")).toBe("English");
    expect(
      renderCoreMemory([{ label: "story", content: "Remember this" }], "EN_us"),
    ).toContain("[Core Memory]");
  });

  it("bounds aggregate core memory while retaining every block envelope", () => {
    const rendered = renderCoreMemory(
      [
        { label: "story", content: "a".repeat(400) },
        { label: "scene", content: "b".repeat(400) },
        { label: "clues", content: "c".repeat(400) },
      ],
      "en-US",
      { maxTokens: 220, estimator: (text) => text.length },
    );

    expect(rendered.length).toBeLessThanOrEqual(220);
    expect(rendered).toContain("<story>");
    expect(rendered).toContain("<scene>");
    expect(rendered).toContain("<clues>");
    expect(rendered).toContain("[truncated]");
  });
});
