import { afterEach, describe, expect, it } from "vitest";
import i18n, { i18nReady } from "../index.js";

describe("lazy locale catalogs", () => {
  afterEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("loads a discovered catalog when its language is selected", async () => {
    await i18nReady;
    await i18n.changeLanguage("ru-RU");

    expect(i18n.resolvedLanguage).toBe("ru-RU");
    expect(i18n.t("common.close")).toBe("Закрыть");
    expect(i18n.hasResourceBundle("ru-RU", "translation")).toBe(true);
  });
});
