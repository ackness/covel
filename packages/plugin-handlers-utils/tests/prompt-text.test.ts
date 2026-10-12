import { describe, expect, it } from "vitest";
import { interpolate } from "../src/prompt-text.js";

describe("interpolate", () => {
  it("fills what the earlier expression matched, and nothing else", () => {
    const variables = { a: "A", "{a": "B", n: 3 };
    const cases: [string, string][] = [
      ["{{a}} and {{  a\n}} and {{ n }}", "A and A and 3"],
      ["{{ missing }}|{{ a.b }}", "|"],
      // The first `}` after `{{` ends the name: these are not variables.
      ["{{}} {{a}b}} {{a} }", "{{}} {{a}b}} {{a} }"],
      // A name may start with a brace; a blank name renders empty.
      ["{{{a}} {{ }}", "B "],
      ["{{ a", "{{ a"],
      // A value is not read again as a template.
      ["{{a}}{{a}}$&", "AA$&"],
    ];
    for (const [template, expected] of cases)
      expect(interpolate(template, variables)).toBe(expected);
  });

  it("stays fast on an unclosed variable with a long run of whitespace", () => {
    // Cubic with the earlier expression: 4,000 tabs took half a minute.
    const template = `{{${"\t".repeat(200_000)}`;
    expect(interpolate(`{{a}}${template}`, { a: "A" })).toBe(`A${template}`);
    const braces = "{".repeat(200_000);
    expect(interpolate(braces, {})).toBe(braces);
  });
});
