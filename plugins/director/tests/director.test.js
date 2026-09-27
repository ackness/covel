import { describe, it, expect } from "vitest";
import entry from "../server/index.js";
import { PREAMBLE_EN, PREAMBLE_ZH } from "../hooks/_preamble.js";

describe("director prompt segment", () => {
  function project(locale) {
    let provider;
    entry({
      provideExtension(point, id, implementation) {
        expect(point).toBe("prompt.segment@1");
        expect(id).toBe("direction");
        provider = implementation;
      },
    });
    return provider.handler({}, { locale });
  }
  it("declares stable story-only guidance", () => {
    expect(project()).toEqual([
      {
        id: "direction",
        content: PREAMBLE_EN,
        position: "system",
        audience: "story",
        volatility: "stable",
      },
    ]);
  });
  it("localizes guidance from the execution locale", () => {
    expect(project("zh-CN")[0].content).toBe(PREAMBLE_ZH);
  });
});
