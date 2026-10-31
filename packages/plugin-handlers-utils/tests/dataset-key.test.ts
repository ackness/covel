import { describe, expect, it } from "vitest";
import { datasetKey } from "../src/index.js";

describe("datasetKey", () => {
  it("folds fullwidth forms to ASCII", () => {
    expect(datasetKey("ＯＬＤ ＭＡＲＡ")).toBe("old mara");
    expect(datasetKey("Ｓｗｏｒｄ＿０１")).toBe("sword_01");
  });

  it("trims and collapses every whitespace run to one space", () => {
    expect(datasetKey("  Old  Mara  ")).toBe("old mara");
    expect(datasetKey("old\t\tmara")).toBe("old mara");
    expect(datasetKey("old\n mara\r\n")).toBe("old mara");
    // U+3000 ideographic space folds to a plain space under NFKC.
    expect(datasetKey("　老　　玛拉　")).toBe("老 玛拉");
  });

  it("lower-cases letters", () => {
    expect(datasetKey("Old Mara")).toBe("old mara");
    expect(datasetKey("ÉLAN")).toBe("élan");
  });

  it("keeps CJK text unchanged", () => {
    expect(datasetKey("铁剑")).toBe("铁剑");
    expect(datasetKey("鉄の剣")).toBe("鉄の剣");
  });

  it("reduces whitespace-only text to the empty key", () => {
    expect(datasetKey("  ")).toBe("");
    expect(datasetKey("　\t")).toBe("");
  });

  it("is idempotent", () => {
    for (const text of [
      "  Old  Mara ",
      "ＯＬＤ ＭＡＲＡ",
      "Sword_01",
      "　老　玛拉",
      "ﬁre",
      "",
    ])
      expect(datasetKey(datasetKey(text))).toBe(datasetKey(text));
  });
});
