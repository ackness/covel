// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import i18n from "@/i18n";
import zh from "../locales/zh-CN.json";

afterEach(() => i18n.changeLanguage("en-US"));
it("F-086 declines model counts and Russian token counts", async () => {
  await i18n.changeLanguage("en-US");
  expect(i18n.t("settings.addModelsCount", { count: 1 })).toBe("Add 1 model");
  expect(i18n.t("settings.addModelsCount", { count: 2 })).toBe("Add 2 models");
  await i18n.changeLanguage("ru-RU");
  for (const [count, expected] of [
    [1, "1 токен"],
    [2, "2 токена"],
    [5, "5 токенов"],
    [21, "21 токен"],
  ] as const) {
    expect(i18n.t("debugger.tokenCount", { count })).toBe(expected);
  }
});
it("F-085 translates weight options and token count in Chinese", async () => {
  for (const token of ["--story-font-weight", "--title-font-weight"] as const) {
    expect(
      Object.values(zh.appearance.tokenEditor.tokens[token].options).every(
        (value) => /[\u4e00-\u9fff]/.test(value),
      ),
    ).toBe(true);
  }
  await i18n.changeLanguage("zh-CN");
  expect(i18n.t("debugger.tokenCount", { count: 2 })).toBe("2 个 token");
});
