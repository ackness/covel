import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOCALE, resolveInitialLocale } from "../locale-detector.js";

describe("locale detector", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["zh-Hans", "zh-CN"],
    ["en_GB", "en-US"],
    ["en-GB", "en-US"],
    ["ru", "ru-RU"],
    ["ru-BY", "ru-RU"],
    ["ru-RU", "ru-RU"],
    ["zh-TW", "en-US"],
    ["zh-Hant-TW", "en-US"],
    ["zh-HK", "en-US"],
  ] as const)("maps navigator locale %s to %s", (language, expected) => {
    vi.stubGlobal("navigator", { language });
    expect(resolveInitialLocale()).toBe(expected);
  });

  it("uses the registry default for an unregistered browser language", () => {
    vi.stubGlobal("navigator", { language: "fr-FR" });
    expect(resolveInitialLocale()).toBe(DEFAULT_LOCALE);
  });
});
