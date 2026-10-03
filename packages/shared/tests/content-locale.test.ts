import { describe, expect, it } from "vitest";
import { sessionContentLocale, worldEditionLocales } from "../src/index.js";

const bilingual = {
  locale: "zh-CN",
  metadata: { supportedLocales: ["zh-CN", "en-US"] },
};
const chineseOnly = { locale: "zh-CN", metadata: {} };

describe("sessionContentLocale", () => {
  it("gives the language asked for when the world has that edition", () => {
    expect(sessionContentLocale(bilingual, "en-US")).toEqual({
      locale: "en-US",
      changed: false,
    });
    expect(sessionContentLocale(bilingual, "zh-CN")).toEqual({
      locale: "zh-CN",
      changed: false,
    });
  });

  it("uses the edition of the same language for another region", () => {
    // British English reads the world's `en-US` files: that is the edition.
    expect(sessionContentLocale(bilingual, "en-GB")).toEqual({
      locale: "en-US",
      changed: false,
    });
    expect(sessionContentLocale(bilingual, "zh")).toEqual({
      locale: "zh-CN",
      changed: false,
    });
  });

  it("gives the world's own language when it has no edition in the one asked for", () => {
    expect(sessionContentLocale(chineseOnly, "en-US")).toEqual({
      locale: "zh-CN",
      changed: true,
    });
    expect(sessionContentLocale(bilingual, "ru-RU")).toEqual({
      locale: "zh-CN",
      changed: true,
    });
    // Traditional Chinese is another script: not the Simplified edition.
    expect(sessionContentLocale(chineseOnly, "zh-Hant-TW")).toEqual({
      locale: "zh-CN",
      changed: true,
    });
  });

  it("keeps the request when nothing is known about the world", () => {
    expect(sessionContentLocale(undefined, "ru-RU")).toEqual({
      locale: "ru-RU",
      changed: false,
    });
    expect(sessionContentLocale({ metadata: {} }, "ru-RU")).toEqual({
      locale: "ru-RU",
      changed: false,
    });
  });
});

describe("worldEditionLocales", () => {
  it("lists the declared editions, or the world's own language", () => {
    expect(worldEditionLocales(bilingual)).toEqual(["zh-CN", "en-US"]);
    expect(worldEditionLocales(chineseOnly)).toEqual(["zh-CN"]);
    expect(worldEditionLocales(undefined)).toEqual([]);
  });
});
