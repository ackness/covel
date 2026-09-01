import { describe, expect, it } from "vitest";
import {
  buildCurrentTurnUserMessage,
  buildFrameworkPreamble,
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
    expect(resolveLocaleLanguageName("en_GB")).toBe("British English");
    expect(
      renderCoreMemory([{ label: "story", content: "Remember this" }], "EN_us"),
    ).toContain("[Core Memory]");
    expect(resolveLocaleLanguageName("ru-RU")).toBe("Русский");
    expect(resolveLocaleLanguageName("zh-Hant-TW")).toContain("繁體");
    expect(resolveLocaleLanguageName("zh-Hant-TW")).not.toContain("简体");
    expect(
      renderCoreMemory([{ label: "story", content: "Помнить" }], "ru-RU"),
    ).toContain("[Core Memory]");
  });

  it("uses the English framework skeleton for Traditional Chinese locales", () => {
    expect(
      buildCurrentTurnUserMessage({
        playerMessage: "",
        locale: "zh-Hant-TW",
      }),
    ).toContain("Begin the current game turn");
    expect(
      renderCoreMemory(
        [{ label: "story", content: "保留繁體內容" }],
        "zh-Hant-TW",
      ),
    ).toContain("[Core Memory]");

    const preamble = buildFrameworkPreamble("zh-Hant-TW");
    expect(preamble).toContain("[COMPLETION] When you have finished");
    expect(preamble).not.toContain("本 runtime 完成");
    expect(preamble).toContain("繁體");
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
