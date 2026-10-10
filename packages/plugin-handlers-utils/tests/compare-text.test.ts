import { describe, expect, it } from "vitest";
import { compareText } from "../src/compare-text.js";

function codePoints(text: string): number[] {
  return Array.from(text, (char) => char.codePointAt(0)!);
}

/** The order a binary-collated UTF-8 column gives. */
function byCodePoint(a: string, b: string): number {
  const left = codePoints(a);
  const right = codePoints(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
}

describe("compareText", () => {
  it("orders by code point, astral characters after the rest of the plane", () => {
    const values = [
      "world-init/schema-gen",
      "world-init",
      "world_time",
      "World",
      "阿",
      "张三",
      "李四",
      "\u{1F600}",
      "�",
      "a\u{1F600}",
      "a�",
      "",
      "10",
      "9",
    ];
    expect([...values].sort(compareText)).toEqual(
      [...values].sort(byCodePoint),
    );
    // UTF-16 code unit order would put the emoji first.
    expect(compareText("\u{1F600}", "�")).toBeGreaterThan(0);
    expect(compareText("same", "same")).toBe(0);
  });
});
