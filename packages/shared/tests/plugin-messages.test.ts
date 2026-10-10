import { describe, expect, it } from "vitest";
import { translate, labelText } from "@covel/plugin-handlers-utils";
import {
  pluginMessagesFor,
  resolveI18nText,
  type PluginMessageCatalog,
} from "../src/index.js";

const catalogs: PluginMessageCatalog[] = [
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

  it("resolves each message through exact, language and English fallbacks", () => {
    const partial: PluginMessageCatalog[] = [
      { locale: "zh-SG", messages: { Continue: "区域继续" } },
      { locale: "zh-CN", messages: { Success: "操作成功" } },
      {
        locale: "zh",
        messages: { Success: "成功", Failure: "失败", Continue: "继续" },
      },
      { locale: "ja", messages: { Missing: "翻訳" } },
    ];
    for (const ordered of [partial, [...partial].reverse()]) {
      expect(pluginMessagesFor(ordered, "zh-CN")?.translations).toEqual({
        Success: "操作成功",
        Failure: "失败",
        Continue: "继续",
      });
    }
    const context = { messages: pluginMessagesFor(partial, "zh-CN") };
    expect(translate(context, "Failure")).toBe("失败");
    expect(translate(context, "Missing")).toBe("Missing");
    expect(resolveI18nText(labelText(context, "Failure"), "zh-CN")).toBe(
      translate(context, "Failure"),
    );
    for (const locale of ["en-US", "ru-RU", "zh-Hant"]) {
      const fallback = { messages: pluginMessagesFor(partial, locale) };
      expect(fallback.messages?.translations).toEqual({});
      expect(translate(fallback, "Failure")).toBe("Failure");
    }
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
