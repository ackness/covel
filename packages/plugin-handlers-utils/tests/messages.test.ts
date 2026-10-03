import { describe, expect, it } from "vitest";
import { labelText, translate, type PluginMessages } from "../src/index.js";

const messages: PluginMessages = {
  translations: {
    "World time: {display}": "世界时间：{display}",
    Success: "成功",
  },
  labels: {
    Success: { zh: "成功", ja: "成功だ" },
  },
};

describe("translate", () => {
  it("gives the text in the session's language and fills the placeholders", () => {
    expect(
      translate({ messages }, "World time: {display}", { display: "09:00" }),
    ).toBe("世界时间：09:00");
    expect(translate({ messages }, "Success")).toBe("成功");
  });

  it("gives the English text when there is no translation or no catalog", () => {
    expect(translate({ messages }, "Failure")).toBe("Failure");
    expect(translate({}, "Rolled {n}", { n: 3 })).toBe("Rolled 3");
    expect(translate(undefined, "Rolled {n}", { n: 3 })).toBe("Rolled 3");
  });

  it("leaves a placeholder that has no value, and ignores inherited names", () => {
    expect(translate(undefined, "{a} and {b}", { a: 1 })).toBe("1 and {b}");
    // `constructor` is on every object; it is not a translation or a value.
    expect(translate({ messages }, "constructor")).toBe("constructor");
    expect(translate(undefined, "{constructor}", {})).toBe("{constructor}");
  });
});

describe("labelText", () => {
  it("gives every language the plugin ships, for the client to pick from", () => {
    expect(labelText({ messages }, "Success")).toEqual({
      en: "Success",
      zh: "成功",
      ja: "成功だ",
    });
  });

  it("gives the English text when there is no translation", () => {
    expect(labelText({ messages }, "Failure")).toBe("Failure");
    expect(labelText(undefined, "Success")).toBe("Success");
    expect(labelText({ messages }, "toString")).toBe("toString");
  });
});
