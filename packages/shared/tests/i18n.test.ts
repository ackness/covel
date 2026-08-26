import { describe, expect, it } from "vitest";
import {
  localeLanguage,
  resolveI18nDeep,
  resolveI18nText,
} from "../src/index.js";

describe("i18n utilities", () => {
  it("normalizes regional and underscore locale forms", () => {
    expect(localeLanguage("en-US")).toBe("en");
    expect(localeLanguage(" ZH_cn ")).toBe("zh");
    expect(localeLanguage(undefined)).toBeUndefined();
  });

  it("uses one exact, language, English, then first-value fallback order", () => {
    expect(resolveI18nText({ zh: "中文", en: "English" }, "en-US")).toBe(
      "English",
    );
    expect(
      resolveI18nText(
        { en: "Generic", "en-GB": "British", zh: "中文" },
        "en-GB",
      ),
    ).toBe("British");
    expect(resolveI18nText({ fr: "Français", en: "English" }, "de-DE")).toBe(
      "English",
    );
    expect(resolveI18nText({ fr: "Français" }, "de-DE")).toBe("Français");
  });

  it("preserves author order when no locale was supplied", () => {
    expect(resolveI18nText({ zh: "中文", en: "English" })).toBe("中文");
  });

  it("deep-resolves locale maps with the same fallback rules", () => {
    expect(
      resolveI18nDeep(
        {
          title: { ZH_cn: "中文标题", EN_us: "English title" },
          items: [{ label: { fr: "Français", en: "English" } }],
        },
        "de-DE",
      ),
    ).toEqual({
      title: "English title",
      items: [{ label: "English" }],
    });
  });
});
