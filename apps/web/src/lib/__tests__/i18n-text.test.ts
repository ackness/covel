import { describe, expect, it } from "vitest";
import { resolveDisplayText } from "../i18n-text.js";

describe("resolveDisplayText", () => {
  it("uses the shared language-prefix and English fallback rules", () => {
    expect(resolveDisplayText({ zh: "中文", en: "English" }, "en-US")).toBe(
      "English",
    );
    expect(resolveDisplayText({ fr: "Français", en: "English" }, "de-DE")).toBe(
      "English",
    );
  });

  it("drops malformed nested values", () => {
    expect(
      resolveDisplayText(
        { "zh-CN": { nested: "invalid" }, "en-US": "Valid" },
        "zh-CN",
      ),
    ).toBe("Valid");
  });

  it("preserves primitive UI values", () => {
    expect(resolveDisplayText(42, "en-US")).toBe("42");
    expect(resolveDisplayText(false, "en-US")).toBe("false");
    expect(resolveDisplayText(null, "en-US")).toBe("");
  });
});
