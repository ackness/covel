import { describe, expect, it } from "vitest";
import {
  instructionLocaleFor,
  instructionLocaleOverride,
  instructionVariantCandidates,
  isInstructionVariantLocale,
} from "../src/utils/instruction-locale.js";

describe("instruction locale", () => {
  it("reads Chinese instructions only for Simplified Chinese sessions", () => {
    for (const locale of ["zh", "zh-CN", "zh_cn", "zh-Hans", "zh-SG"])
      expect(instructionLocaleFor(locale, undefined)).toBe("zh");
    for (const locale of [
      "zh-Hant",
      "zh-TW",
      "zh-HK",
      "en-US",
      "ru-RU",
      "ja-JP",
      "",
      undefined,
    ])
      expect(instructionLocaleFor(locale, undefined)).toBe("en");
  });

  it("tries the session's own tag before the shared Chinese variant", () => {
    expect(instructionVariantCandidates("zh-CN", undefined)).toEqual([
      "zh-CN",
      "zh",
    ]);
    expect(instructionVariantCandidates("zh", undefined)).toEqual(["zh"]);
    expect(instructionVariantCandidates("zh-Hant-TW", undefined)).toEqual([]);
    expect(instructionVariantCandidates("ru-RU", undefined)).toEqual([]);
  });

  it("applies the override to every session without changing which files are variants", () => {
    expect(instructionLocaleFor("zh-CN", "en")).toBe("en");
    expect(instructionVariantCandidates("zh-CN", "en")).toEqual([]);
    expect(instructionLocaleFor("ru-RU", "zh")).toBe("zh");
    expect(instructionVariantCandidates("ru-RU", "zh")).toEqual(["zh"]);
    expect(instructionVariantCandidates("zh-Hant", "zh")).toEqual(["zh"]);
    expect(isInstructionVariantLocale("zh-CN")).toBe(true);
    expect(isInstructionVariantLocale("zh-Hant")).toBe(false);
    expect(isInstructionVariantLocale("ru")).toBe(false);
  });

  it("accepts only the two instruction languages as an override", () => {
    expect(
      instructionLocaleOverride({ COVEL_INSTRUCTION_LOCALE: " EN " }),
    ).toBe("en");
    expect(instructionLocaleOverride({ COVEL_INSTRUCTION_LOCALE: "zh" })).toBe(
      "zh",
    );
    expect(
      instructionLocaleOverride({ COVEL_INSTRUCTION_LOCALE: "ru" }),
    ).toBeUndefined();
    expect(instructionLocaleOverride({})).toBeUndefined();
  });
});
