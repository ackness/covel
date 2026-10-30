import { describe, expect, it } from "vitest";
import { replaceLoreFragment, splitLore } from "./lore-boundaries.js";

describe("lore boundary whitespace", () => {
  it("preserves marker variants and their original line endings", () => {
    const open = "<!-- \tNarrator_Only -->\r\n";
    const close = "<!-- \t/ \tNarrator Only -->\r\n";
    expect(splitLore(`${open}secret\r\n${close}`)).toEqual([
      { kind: "text", text: "", hidden: false },
      { kind: "marker", text: open },
      { kind: "text", text: "secret\r\n", hidden: true },
      { kind: "marker", text: close },
      { kind: "text", text: "", hidden: false },
    ]);
  });
  it("handles long non-marker whitespace and retains fragment spacing", () => {
    const whitespace = "\t".repeat(100_000);
    const text = `<!--${whitespace}x`;
    expect(splitLore(text)).toEqual([{ kind: "text", text, hidden: false }]);
    expect(replaceLoreFragment(`\r\nold${whitespace}x\r\n`, " new ")).toBe(
      "\r\nnew\r\n",
    );
    expect(replaceLoreFragment(`\told${whitespace}`, "new")).toBe(
      `\tnew${whitespace}`,
    );
    expect(replaceLoreFragment(" \t", "new")).toBe("new\n");
  });
});
