import { expect, it } from "vitest";
import { resolveMacros } from "../../src/world-import/st/macros.js";
it.each([
  ["zh-CN", "玩家"],
  ["en-US", "the player"],
])("resolves names for %s", (locale, user) => {
  expect(
    resolveMacros("{{char}} <BOT> {{user}} <USER>", "Mira", locale).text,
  ).toBe(`Mira Mira ${user} ${user}`);
});
it("omits comments and original and never evaluates unknown macros", () => {
  expect(
    resolveMacros(
      "a{{// comment}}{{original}}{{getvar::x}}{{random:1,2}}b",
      "Mira",
      "en-US",
    ),
  ).toEqual({ text: "ab", removed: 2, names: ["getvar", "random"] });
});
it("caps names at ten", () =>
  expect(
    resolveMacros(
      Array.from({ length: 20 }, (_, i) => `{{macro${i}}}`).join(""),
      "Mira",
      "en-US",
    ).names,
  ).toHaveLength(10));
it("handles repeated unclosed comment delimiters without rescanning", () => {
  const input = "{{//".repeat(100000);
  expect(resolveMacros(input, "Mira", "en-US").text).toBe(input);
});
it("reports character macros that have no character in scope", () => {
  expect(resolveMacros("A {{char}} and <BOT> speak.", "", "en-US")).toEqual({
    text: "A  and  speak.",
    removed: 2,
    names: ["char", "BOT"],
  });
});
