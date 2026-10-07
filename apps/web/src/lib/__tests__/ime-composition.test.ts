// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isImeComposing } from "../ime-composition.js";

describe("input-method composition check", () => {
  it("claims key presses made while a candidate is being composed", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(
      isImeComposing({ nativeEvent: { isComposing: true, keyCode: 229 } }),
    ).toBe(true);
  });

  it("claims the commit key Safari reports after the composition ended", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("leaves an ordinary Enter or Escape to the field", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(
      isImeComposing({ nativeEvent: { isComposing: false, keyCode: 27 } }),
    ).toBe(false);
  });
});
