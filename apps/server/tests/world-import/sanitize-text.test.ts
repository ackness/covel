import { describe, expect, it } from "vitest";
import { sanitizeText } from "../../src/world-import/st/sanitize-text.js";
describe("sanitizeText", () => {
  it.each([
    ["<script>alert(1)</script>x", "x"],
    ["<b>hi</b>", "hi"],
    ["a<br>b", "a\nb"],
    ["a<!-- hidden -->b", "ab"],
    ["[a](javascript:alert(1))", "a"],
    ["![a](data:text/html,x)", "a"],
    ["---\nx", "- - -\nx"],
    ["a\0\u0001\ud800b\r\nc", "ab\nc"],
    ["e\u0301", "é"],
    ["<svg><script>evil</script>hidden</svg>ok", "ok"],
    ["<iframe>unclosed", ""],
    ["<img src=x>ok", "ok"],
  ])("cleans %j", (input, output) =>
    expect(sanitizeText(input).text).toBe(output),
  );
  it("counts removed constructs", () =>
    expect(sanitizeText("<b>x</b><!--c--><script>x</script>").removed).toBe(4));
});
it("does not assemble active tags during stripping", () => {
  expect(
    sanitizeText("<<script>discard</script>script>hidden</script>safe").text,
  ).toBe("");
});
it("bounds scans of malformed tags and repeated void elements", () => {
  expect(sanitizeText("<b".repeat(100000)).text).toBe("");
  expect(sanitizeText("<img>".repeat(10000) + "safe").text).toBe("safe");
  expect(sanitizeText("[".repeat(100000)).text).toHaveLength(100000);
});
