import { describe, expect, it } from "vitest";
import { textValue } from "../../src/routes/misc-api/shared.js";

describe("misc API textValue", () => {
  it("uses the shared locale and English fallback rules", () => {
    expect(textValue({ zh: "中文", en: "English" }, "EN_us")).toBe("English");
    expect(textValue({ fr: "Français", en: "English" }, "de-DE")).toBe(
      "English",
    );
  });

  it("ignores non-string fields at the API boundary", () => {
    expect(textValue({ "zh-CN": { nested: "bad" }, en: "Safe" })).toBe("Safe");
  });
});
