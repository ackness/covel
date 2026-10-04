import { describe, expect, it } from "vitest";
import { pluginMessagesFor } from "../src/index.js";

const catalogs = [
  { locale: "ja", messages: { Success: "成功だ" } },
  { locale: "zh", messages: { Success: "成功", Failure: "失败" } },
];

describe("pluginMessagesFor", () => {
  it("reads the catalog of the session's language", () => {
    expect(pluginMessagesFor(catalogs, "zh-CN")?.translations).toEqual({
      Success: "成功",
      Failure: "失败",
    });
    expect(pluginMessagesFor(catalogs, "zh-Hans")?.translations.Success).toBe(
      "成功",
    );
    expect(pluginMessagesFor(catalogs, "ja-JP")?.translations).toEqual({
      Success: "成功だ",
    });
  });

  it("gives no translation to a session of another language or script", () => {
    // Traditional Chinese does not read the Simplified catalog.
    for (const locale of ["en-US", "ru-RU", "zh-Hant-TW", "zh-TW", undefined])
      expect(pluginMessagesFor(catalogs, locale)?.translations).toEqual({});
  });

  it("lists every language of a text, whatever the session's language", () => {
    expect(pluginMessagesFor(catalogs, "en-US")?.labels).toEqual({
      Success: { ja: "成功だ", zh: "成功" },
      Failure: { zh: "失败" },
    });
  });

  it("is nothing for a plugin with no locale files", () => {
    expect(pluginMessagesFor([], "zh-CN")).toBeUndefined();
    expect(pluginMessagesFor(undefined, "zh-CN")).toBeUndefined();
  });
});
