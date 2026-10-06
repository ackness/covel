import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCurrentTurnUserMessage,
  buildFrameworkPreamble,
  resolveLocaleLanguageName,
} from "../src/prompt-internals.js";

afterEach(() => vi.unstubAllEnvs());

describe("prompt locale normalization", () => {
  it("uses the shared language subtag for prompt variants", () => {
    expect(
      buildCurrentTurnUserMessage({
        playerMessage: "",
        locale: "ZH_cn",
      }),
    ).toContain("开始当前游戏回合");
    expect(resolveLocaleLanguageName("en_GB")).toBe("British English");
    expect(resolveLocaleLanguageName("ru-RU")).toBe("Русский");
    expect(resolveLocaleLanguageName("zh-Hant-TW")).toContain("繁體");
    expect(resolveLocaleLanguageName("zh-Hant-TW")).not.toContain("简体");
  });

  it("uses the English framework skeleton for Traditional Chinese locales", () => {
    expect(
      buildCurrentTurnUserMessage({
        playerMessage: "",
        locale: "zh-Hant-TW",
      }),
    ).toContain("Begin the current game turn");

    const preamble = buildFrameworkPreamble("zh-Hant-TW");
    expect(preamble).toContain("[COMPLETION] When you have finished");
    expect(preamble).not.toContain("本 runtime 完成");
    expect(preamble).toContain("繁體");
  });

  it("writes every line of the preamble in the instruction language", () => {
    // A Chinese session read `[RUNTIME]` and `[LANGUAGE]` in English and
    // `[COMPLETION]` in Chinese.
    for (const options of [undefined, { terminatesWithRuntimeDone: false }]) {
      const chinese = buildFrameworkPreamble("zh-CN", options).split("\n");
      expect(
        chinese.map((line) => line.slice(0, line.indexOf("]") + 1)),
      ).toEqual(
        expect.arrayContaining(["[RUNTIME]", "[LANGUAGE]", "[COMPLETION]"]),
      );
      for (const line of chinese) expect(line, line).toMatch(/\p{Script=Han}/u);
      expect(chinese.join("\n")).toContain("必须用简体中文书写");
      expect(buildFrameworkPreamble("en-US", options)).not.toMatch(
        /\p{Script=Han}/u,
      );
    }
  });

  it("separates the instruction language from the output language", () => {
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "en");
    const forcedEnglish = buildFrameworkPreamble("zh-CN");
    expect(forcedEnglish).toContain("[COMPLETION] When you have finished");
    expect(forcedEnglish).toContain("简体中文");
    expect(
      buildCurrentTurnUserMessage({ playerMessage: "", locale: "zh-CN" }),
    ).toContain("Begin the current game turn");

    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "zh");
    const forcedChinese = buildFrameworkPreamble("ru-RU");
    expect(forcedChinese).toContain("本 runtime 完成");
    expect(forcedChinese).toContain("Русский");
  });
});
