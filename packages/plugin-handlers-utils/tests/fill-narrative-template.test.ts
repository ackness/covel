import { describe, expect, it } from "vitest";
import { fillNarrativeTemplate } from "../src/fill-narrative-template.js";

describe("fillNarrativeTemplate", () => {
  it.each([
    [
      "You came {{ origin }}.",
      { origin: "from the coast." },
      "You came from the coast.",
    ],
    ["你因{{reason}}。", { reason: "追寻旧事。" }, "你因追寻旧事。"],
    [
      "{{zero}} / {{no}} / {{missing}} / {{nil}}",
      { zero: 0, no: false, nil: null },
      "0 / false /  / ",
    ],
    [
      "{{name}} / {{name}}",
      { name: "$& {{other}}" },
      "$& {{other}} / $& {{other}}",
    ],
  ])(
    "renders %s without changing supplied text",
    (template, values, expected) => {
      expect(fillNarrativeTemplate(template, values)).toBe(expected);
    },
  );

  it("leaves an unclosed or empty placeholder as text, in linear time", () => {
    const tabs = "\t".repeat(200_000);
    const started = performance.now();
    for (const template of [`{{${tabs}`, `{{{{${tabs}`, `{{{{|${tabs}`]) {
      expect(fillNarrativeTemplate(template, {})).toBe(template);
    }
    expect(performance.now() - started).toBeLessThan(1000);
    expect(fillNarrativeTemplate("{{}} {{ }}", {})).toBe("{{}} ");
  });
});
