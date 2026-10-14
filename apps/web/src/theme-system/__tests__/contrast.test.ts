import { resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { contrastRatio, relativeLuminance } from "../color.js";
import { checkThemeContrast, CONTRAST_PAIRS } from "../contrast.js";
import { getBuiltinThemes } from "../builtins.js";
import { splitSelectorList } from "../validate.js";

it("F-200 measures opaque pairs and reports unknown rather than passing missing colours", () => {
  expect(contrastRatio("#000000", "#ffffff")).toBe(21);
  expect(contrastRatio("#888888", "#888888")).toBe(1);
  const results = checkThemeContrast({
    id: "low",
    schemes: ["light", "dark"],
    cssText:
      'html[data-theme="low"] { --color-background: #ffffff; --color-foreground: #eeeeee; } html[data-theme="low"].dark { --color-background: #000000; --color-foreground: #ffffff; }',
  });
  expect(
    results.find((r) => r.scheme === "light" && r.pair === "body")?.ratio,
  ).toBeLessThan(4.5);
  expect(
    results.find((r) => r.scheme === "dark" && r.pair === "body")?.ratio,
  ).toBe(21);
  expect(results.find((r) => r.pair === "muted")?.ratio).toBeNull();
  expect(document.querySelector("iframe")).toBeNull();
});

/** Independent check of the two opaque colour syntaxes shipped by builtins.
 * CSS Color 4 Oklab conversion: https://www.w3.org/TR/css-color-4/#color-conversion-code
 * Complex/alpha colours must be checked in a browser, not silently accepted here.
 */
function luminance(value: string): number {
  if (/^#[\da-f]{6}$/i.test(value)) return relativeLuminance(value);
  const match = /^oklch\(([\d.]+)(%?) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (!match)
    throw new Error(`Builtin contrast needs an opaque colour: ${value}`);
  const L = Number(match[1]) / (match[2] ? 100 : 1);
  const C = Number(match[3]);
  const hue = (Number(match[4]) * Math.PI) / 180;
  const a = C * Math.cos(hue),
    b = C * Math.sin(hue);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  return (
    0.2126 * clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
    0.7152 * clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
    0.0722 * clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  );
}

it.each(getBuiltinThemes())(
  "F-200 keeps builtin $id token pairs readable in every supported scheme",
  (theme) => {
    const css = readFileSync(
      resolvePath(process.cwd(), "src/themes/builtins", theme.id, "theme.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const scheme of theme.schemes) {
      const tokens: Record<string, string> = {};
      for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (
          !splitSelectorList(selectors!).some((selector) => {
            const root = `html[data-theme="${theme.id}"]`;
            return (
              selector.trim() === root ||
              (scheme === "dark" && selector.trim() === `${root}.dark`)
            );
          })
        )
          continue;
        for (const [, name, value] of body!.matchAll(
          /(--[\w-]+)\s*:\s*([^;]+);/g,
        ))
          tokens[name!] = value!.trim();
      }
      const resolve = (name: string): string => {
        const value = tokens[name];
        if (!value) throw new Error(`Missing builtin token ${name}`);
        const variable = /^var\((--[\w-]+)\)$/.exec(value);
        return variable ? resolve(variable[1]!) : value;
      };
      for (const pair of CONTRAST_PAIRS) {
        const a = luminance(resolve(pair.foreground)),
          b = luminance(resolve(pair.background));
        expect(
          (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          `${theme.id}/${scheme}/${pair.id}`,
        ).toBeGreaterThanOrEqual(pair.minimum);
      }
    }
  },
);
