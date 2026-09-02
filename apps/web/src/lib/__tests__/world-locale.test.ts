import { describe, expect, it } from "vitest";
import type { WorldRecord } from "@/services/api.js";
import {
  isWorldLocaleMismatch,
  prioritizeWorldsByLocale,
  worldLanguage,
  worldLanguageBadge,
  worldLanguageName,
} from "../world-locale.js";

function world(id: string, locale?: string): WorldRecord {
  return {
    id,
    name: id,
    description: id,
    locale,
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

describe("world locale presentation", () => {
  it.each([
    ["en", "en"],
    ["en-US", "en"],
    ["EN_us", "en"],
    ["zh", "zh"],
    ["zh-CN", "zh"],
    ["zh_Hans", "zh"],
    ["ja-JP", "ja"],
    ["not a locale", null],
    ["../../etc", null],
    [`en-${"abcde-".repeat(20)}abcde`, null],
    ["", null],
    [undefined, null],
  ] as const)("normalizes %s to %s", (locale, expected) => {
    expect(worldLanguage(locale)).toBe(expected);
  });

  it("stably prioritizes English worlds for an English interface", () => {
    const worlds = [
      world("zh-one", "zh-CN"),
      world("en-one", "en-US"),
      world("unknown"),
      world("en-two", "EN_us"),
      world("zh-two", "zh-Hans"),
    ];

    expect(
      prioritizeWorldsByLocale(worlds, "en-US").map(({ id }) => id),
    ).toEqual(["en-one", "en-two", "zh-one", "unknown", "zh-two"]);
    expect(worlds.map(({ id }) => id)).toEqual([
      "zh-one",
      "en-one",
      "unknown",
      "en-two",
      "zh-two",
    ]);
  });

  it("stably prioritizes Chinese worlds for a Chinese interface", () => {
    const worlds = [
      world("en", "en-US"),
      world("zh-one", "zh-CN"),
      world("zh-traditional", "zh-TW"),
      world("unknown"),
      world("zh-two", "zh"),
    ];

    expect(
      prioritizeWorldsByLocale(worlds, "zh-CN").map(({ id }) => id),
    ).toEqual(["zh-one", "zh-two", "en", "zh-traditional", "unknown"]);
  });

  it("groups regions only when their likely scripts match", () => {
    const worlds = [
      world("traditional", "zh-TW"),
      world("british", "en-GB"),
      world("simplified", "zh-SG"),
      world("american", "en-US"),
    ];

    expect(
      prioritizeWorldsByLocale(worlds, "zh-CN").map(({ id }) => id),
    ).toEqual(["simplified", "traditional", "british", "american"]);
    expect(
      prioritizeWorldsByLocale(worlds, "en-AU").map(({ id }) => id),
    ).toEqual(["british", "american", "traditional", "simplified"]);
  });

  it("provides concise language badges", () => {
    expect(worldLanguageBadge("en-US")).toBe("EN");
    expect(worldLanguageBadge("zh-CN")).toBe("ZH");
    expect(worldLanguageBadge("ru-RU")).toBe("RU");
    expect(worldLanguageBadge("fr-FR")).toBe("FR");
    expect(worldLanguageBadge("../../etc")).toBeNull();
  });

  it("prioritizes and names a third locale without a code branch", () => {
    const worlds = [world("en", "en-US"), world("ru", "ru-RU")];
    expect(
      prioritizeWorldsByLocale(worlds, "ru-RU").map(({ id }) => id),
    ).toEqual(["ru", "en"]);
    expect(worldLanguageName("ru-RU", "en-US")).toBe("Russian");
    expect(worldLanguageName("ru-RU", "ru-RU")).toBe("Русский");
    expect(worldLanguageName("not a locale", "en-US")).toBeNull();
  });

  it("detects primary-language mismatches without flagging regional variants", () => {
    expect(isWorldLocaleMismatch("en-US", "zh-CN")).toBe(true);
    expect(isWorldLocaleMismatch("ja-JP", "zh-CN")).toBe(true);
    expect(isWorldLocaleMismatch("zh-Hans", "zh-CN")).toBe(false);
    expect(isWorldLocaleMismatch("zh-SG", "zh-CN")).toBe(false);
    expect(isWorldLocaleMismatch("zh-TW", "zh-CN")).toBe(true);
    expect(isWorldLocaleMismatch("zh-Hant", "zh-CN")).toBe(true);
    expect(isWorldLocaleMismatch("en-GB", "en-US")).toBe(false);
    expect(isWorldLocaleMismatch("../../etc", "zh-CN")).toBe(false);
    expect(
      isWorldLocaleMismatch(`en-${"abcde-".repeat(20)}abcde`, "zh-CN"),
    ).toBe(false);
    expect(isWorldLocaleMismatch(undefined, "zh-CN")).toBe(false);
  });
});
