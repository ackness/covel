import { describe, expect, it } from "vitest";
import { buildWebLocaleCatalog } from "../catalog-registry.js";

const baseCatalogs = {
  "./locales/zh-CN.json": { greeting: "你好" },
  "./locales/en-US.json": { greeting: "Hello" },
  "./locales/ru-RU.json": { greeting: "Привет" },
};

describe("Web locale catalog registry", () => {
  it("discovers and loads a contributed locale from only its JSON catalog module", async () => {
    const catalog = buildWebLocaleCatalog({
      ...baseCatalogs,
      "./locales/ja-JP.json": { greeting: "こんにちは" },
    });

    expect(catalog.codes).toEqual(["zh-CN", "en-US", "ru-RU", "ja-JP"]);
    expect(catalog.registry.has("ja-JP")).toBe(true);
    expect(catalog.registry.canonicalize("ja")).toBeUndefined();
    expect(catalog.registry.match("ja")?.code).toBe("ja-JP");
    await expect(catalog.loadCatalog("ja-JP")).resolves.toEqual({
      greeting: "こんにちは",
    });
    expect(catalog.registry.get("ja-JP")).toMatchObject({
      code: "ja-JP",
      shortLabel: "JA",
      fallbackLocales: ["en-US"],
    });
    const japaneseLabel = catalog.registry.get("ja-JP")?.label;
    expect(typeof japaneseLabel).toBe("object");
    expect(
      typeof japaneseLabel === "object" ? japaneseLabel["ja-JP"] : undefined,
    ).toContain("日本語");
    const chineseLabel = catalog.registry.get("zh-CN")?.label;
    expect(
      typeof chineseLabel === "object" ? chineseLabel["ja-JP"] : undefined,
    ).toContain("中国語");
  });

  it("does not load a contributed catalog until it is requested", async () => {
    let loads = 0;
    const catalog = buildWebLocaleCatalog({
      ...baseCatalogs,
      "./locales/ja-JP.json": async () => {
        loads += 1;
        return { greeting: "こんにちは" };
      },
    });

    expect(loads).toBe(0);
    await expect(catalog.loadCatalog("ja")).resolves.toEqual({
      greeting: "こんにちは",
    });
    expect(loads).toBe(1);
  });

  it("loads best-fit catalogs without crossing locale scripts", async () => {
    const catalog = buildWebLocaleCatalog(baseCatalogs);

    await expect(catalog.loadCatalog("en-GB")).resolves.toEqual({
      greeting: "Hello",
    });
    await expect(catalog.loadCatalog("ru-BY")).resolves.toEqual({
      greeting: "Привет",
    });
    await expect(catalog.loadCatalog("zh-TW")).rejects.toThrow(
      "No Web locale catalog for zh-TW",
    );
  });

  it("preserves built-in locale metadata", () => {
    const catalog = buildWebLocaleCatalog(baseCatalogs);

    expect(catalog.registry.get("zh-CN")).toMatchObject({
      shortLabel: "中",
      aliases: ["zh", "zh-Hans"],
    });
    const russianLabel = catalog.registry.get("ru-RU")?.label;
    expect(typeof russianLabel).toBe("object");
    expect(
      typeof russianLabel === "object" ? russianLabel["ru-RU"] : undefined,
    ).toBe("Русский");
  });

  it("rejects invalid catalog filenames", () => {
    expect(() =>
      buildWebLocaleCatalog({
        ...baseCatalogs,
        "./locales/not a locale.json": {},
      }),
    ).toThrow("Invalid BCP 47 locale catalog filename");
  });

  it.each([
    ["en", "en-US"],
    ["zh", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["ru", "ru-RU"],
  ])(
    "rejects catalog code %s when it conflicts with a built-in alias for %s",
    (code, owner) => {
      expect(() =>
        buildWebLocaleCatalog({
          ...baseCatalogs,
          [`./locales/${code}.json`]: { greeting: "conflict" },
        }),
      ).toThrow(
        `Locale catalog code ${code} conflicts with built-in alias for ${owner}`,
      );
    },
  );
});
