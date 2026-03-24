import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  SupportedLocaleSchema,
  normalizeLocale,
  resolveLocaleFromHeader
} from "../src/index.js";

describe("locale contracts", () => {
  it("accepts supported locales", () => {
    expect(SupportedLocaleSchema.parse("zh-CN")).toBe("zh-CN");
    expect(SupportedLocaleSchema.parse("en")).toBe("en");
  });

  it("normalizes locale variants into supported locales", () => {
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale("zh-TW")).toBe("zh-CN");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("fr-FR")).toBe(DEFAULT_LOCALE);
  });

  it("resolves the highest available locale from Accept-Language headers", () => {
    expect(resolveLocaleFromHeader("en-US,en;q=0.9,zh-CN;q=0.8")).toBe("en");
    expect(resolveLocaleFromHeader("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh-CN");
    expect(resolveLocaleFromHeader("fr-FR,fr;q=0.9")).toBe(DEFAULT_LOCALE);
  });
});
