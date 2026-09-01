import { describe, expect, it } from "vitest";
import {
  DEFAULT_FALLBACK_LOCALE,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  canonicalizeLocale,
  defineLocaleRegistry,
  isDefaultLocale,
  isLocaleCode,
  localeDisplayName,
  localeLanguage,
  localeLookupCandidates,
  localeRegistry,
  localesShareLanguageAndScript,
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
    expect(resolveI18nText({ ru: "Русский", en: "English" }, "ru-RU")).toBe(
      "Русский",
    );
  });

  it("never crosses scripts during same-language fallback", () => {
    expect(
      resolveI18nText(
        { "zh-CN": "简体中文", "en-US": "English" },
        "zh-Hant-TW",
      ),
    ).toBe("English");
    expect(
      resolveI18nText(
        {
          "zh-CN": "简体中文",
          "zh-TW": "繁體中文",
          "en-US": "English",
        },
        "zh-Hant-HK",
      ),
    ).toBe("繁體中文");
    expect(resolveI18nText({ zh: "中文", en: "English" }, "zh-Hans")).toBe(
      "中文",
    );
    expect(resolveI18nText({ en: "English" }, "en-GB")).toBe("English");
    expect(resolveI18nText({ ru: "Русский" }, "ru-BY")).toBe("Русский");
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

  it("deep-resolves extended BCP 47 locale maps", () => {
    expect(
      resolveI18nDeep(
        {
          script: { "sr-Latn": "Latinica", en: "Latin" },
          threeLetter: { fil: "Filipino", en: "English" },
        },
        "sr-Latn-RS",
      ),
    ).toEqual({ script: "Latinica", threeLetter: "English" });

    expect(
      resolveI18nDeep(
        {
          calendar: {
            "en-u-ca-gregory": "Gregorian English",
            en: "English",
          },
        },
        "en-u-ca-gregory",
      ),
    ).toEqual({ calendar: "Gregorian English" });
  });
});

describe("locale registry", () => {
  it("canonicalizes safe BCP 47 values and rejects path-like input", () => {
    expect(canonicalizeLocale("ru_ru")).toBe("ru-RU");
    expect(canonicalizeLocale("sr-latn-rs")).toBe("sr-Latn-RS");
    expect(canonicalizeLocale("en-u-ca-gregory")).toBe("en-u-ca-gregory");
    expect(canonicalizeLocale("../../etc/passwd")).toBeUndefined();
    expect(canonicalizeLocale("en-US.json")).toBeUndefined();
    expect(isLocaleCode("ja-JP")).toBe(true);
    expect(isLocaleCode("not a locale")).toBe(false);
    expect(
      canonicalizeLocale(`en-${Array(8).fill("abcdefgh").join("-")}`),
    ).toBeUndefined();
  });

  it("derives supported codes, aliases, labels and defaults from definitions", () => {
    expect(SUPPORTED_LOCALES).toEqual(["zh-CN", "en-US", "ru-RU"]);
    expect(DEFAULT_LOCALE).toBe("zh-CN");
    expect(DEFAULT_FALLBACK_LOCALE).toBe("en-US");
    expect(localeRegistry.canonicalize("RU_ru")).toBe("ru-RU");
    expect(localeRegistry.canonicalize("ru")).toBe("ru-RU");
    expect(localeRegistry.resolve("zh-TW")).toBeUndefined();
    expect(localeRegistry.match("en-GB")?.code).toBe("en-US");
    expect(localeRegistry.match("ru-BY")?.code).toBe("ru-RU");
    expect(localeRegistry.match("zh-TW")).toBeUndefined();
    expect(localeRegistry.match("zh-Hant-TW")).toBeUndefined();
    expect(localeRegistry.has("ru-RU")).toBe(true);
    expect(localeRegistry.has("ru")).toBe(false);
    expect(isDefaultLocale("zh-CN")).toBe(true);
    expect(isDefaultLocale("zh")).toBe(true);
    expect(isDefaultLocale("zh-Hans")).toBe(true);
    expect(isDefaultLocale("zh-Hant")).toBe(false);
    expect(isDefaultLocale("zh-TW")).toBe(false);
  });

  it("renders unregistered locale variants without collapsing their script", () => {
    expect(localeDisplayName("zh-Hant-TW")).toContain("繁體");
    expect(localeDisplayName("zh-Hant-TW")).not.toContain("简体");
  });

  it("builds exact and script-compatible primary-language candidates", () => {
    expect(localeLookupCandidates("ru_BY")).toEqual(["ru-BY", "ru"]);
    expect(localeLookupCandidates("en-GB")).toEqual(["en-GB", "en"]);
    expect(localeLookupCandidates("zh-Hans-CN")).toEqual(["zh-Hans-CN", "zh"]);
    expect(localeLookupCandidates("zh-Hant-TW")).toEqual(["zh-Hant-TW"]);
    expect(localeLookupCandidates("../../etc/passwd")).toEqual([]);
    expect(localesShareLanguageAndScript("zh-Hant", "zh-CN")).toBe(false);
    expect(localesShareLanguageAndScript("zh-Hans", "zh")).toBe(true);
  });

  it("supports independently composed contributor registries", () => {
    const registry = defineLocaleRegistry(
      [
        {
          code: "en-US",
          label: "English",
          shortLabel: "EN",
        },
        {
          code: "ja-JP",
          label: { ja: "日本語", en: "Japanese" },
          shortLabel: "JA",
          aliases: ["ja"],
          fallbackLocales: ["en-US"],
        },
      ],
      { defaultLocale: "en-US", fallbackLocale: "en-US" },
    );

    expect(registry.codes).toEqual(["en-US", "ja-JP"]);
    expect(registry.canonicalize("ja_JP")).toBe("ja-JP");
    expect(registry.fallbackLocalesFor("ja-JP")).toEqual(["en-US"]);
  });

  it("rejects non-canonical codes and unsafe fallback locales", () => {
    expect(() =>
      defineLocaleRegistry(
        [{ code: "en_us", label: "English", shortLabel: "EN" }],
        { defaultLocale: "en_us", fallbackLocale: "en_us" },
      ),
    ).toThrow("Locale code must be canonical");

    expect(() =>
      defineLocaleRegistry(
        [
          {
            code: "en-US",
            label: "English",
            shortLabel: "EN",
            fallbackLocales: ["../../README"],
          },
        ],
        { defaultLocale: "en-US", fallbackLocale: "en-US" },
      ),
    ).toThrow("Invalid fallback locale");
  });
});
