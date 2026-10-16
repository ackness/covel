import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/token-estimation.js";

describe("token estimation", () => {
  it.each([
    "",
    "Latin words and punctuation!",
    "中文、かな、カナ、한글、全角ＡＢＣ",
    "Mixed 中文 𠀀 😀 café\ud800\udfff",
    Array.from({ length: 0x10000 }, (_, code) =>
      String.fromCharCode(code),
    ).join(""),
  ])("matches the UTF-16 regex estimator (case %#)", (text) => {
    const count =
      text.match(/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g)
        ?.length ?? 0;
    expect(estimateTokens(text)).toBe(
      count + Math.ceil((text.length - count) / 4),
    );
  });
});
