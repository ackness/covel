import { describe, expect, it } from "vitest";
import { deriveThemeCss } from "../theme-css-derive.js";

describe("theme CSS derivation", () => {
  it("preserves conditional effects, source priority and unsupported rules verbatim", () => {
    const source = `@layer tokens, effects;
@layer tokens {
  html[data-theme="source"] { --color-primary: red !important; }
}
@layer effects {
  @when media(width > 100px) {
    html[data-theme="source"] body::after {
      future-property: unrecognised(value);
      content: "[data-theme='source'] { ; }";
    }
  }
}
@media (prefers-reduced-motion: reduce) {
  html[data-theme="source"][data-turn="executing"] body::after { animation: none; }
}`;
    const result = deriveThemeCss(source, "source", "saved");
    expect(result).toBe(
      source.replaceAll('[data-theme="source"]', '[data-theme="saved"]'),
    );
  });

  it("isolates keyframes and their shorthand, longhand and variable references", () => {
    const result = deriveThemeCss(
      `
@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
@media (width > 10px) {
  @keyframes pulse { from { opacity: 0.5; } to { opacity: 1; } }
}
@keyframes 'slide in' { from { translate: 0 10px; } to { translate: 0 0; } }
html[data-theme="source"] {
  --Motion: var(--inner);
  --inner: pulse 2s linear, 'slide in' 1s ease;
  --unused: pulse;
  content: "pulse";
  animation: var(--Motion);
}
html[data-theme="source"] body::after {
  animation-name: pulse, 'slide in';
  animation: pulse 2s linear, "slide in" 1s;
}`,
      "source",
      "saved",
    );
    expect(result.match(/@keyframes covel-saved-0/g)).toHaveLength(2);
    expect(result).toContain("@keyframes covel-saved-1");
    expect(result).toContain(
      "--inner: covel-saved-0 2s linear, covel-saved-1 1s ease;",
    );
    expect(result).toContain("--unused: pulse;");
    expect(result).toContain('content: "pulse";');
    expect(result).toContain("animation-name: covel-saved-0, covel-saved-1;");
    expect(result).toContain(
      "animation: covel-saved-0 2s linear, covel-saved-1 1s;",
    );
  });

  it("does not confuse animation keywords with identically named keyframes", () => {
    const result = deriveThemeCss(
      `
@keyframes linear { from { opacity: 0; } }
html[data-theme="source"] {
  animation: linear 1s linear;
  animation-name: linear;
  animation-timing-function: linear;
}
html[data-theme="source"] body {
  animation: cubic-bezier(0, 0, 1, 1) 1s linear;
}`,
      "source",
      "saved",
    );
    expect(result).toContain("animation: linear 1s covel-saved-0;");
    expect(result).toContain("animation-name: covel-saved-0;");
    expect(result).toContain("animation-timing-function: linear;");
    expect(result).toContain(
      "animation: cubic-bezier(0, 0, 1, 1) 1s covel-saved-0;",
    );
  });

  it("handles nested rules, comments, fallbacks and cyclic variables", () => {
    const result = deriveThemeCss(
      `
/* @keyframes fake { from {} } */
@keyframes pulse /* keep */ { from { opacity: 0; } }
html[data-theme="source"] {
  --a: var(--b);
  --b: var(--a, pulse 1s);
  &:hover { animation: var(--a, pulse/* keep */ 2s ease); }
  &::after { animation-name: var(--name, "pulse"); }
}`,
      "source",
      "saved",
    );
    expect(result).toContain("/* @keyframes fake { from {} } */");
    expect(result).toContain("@keyframes covel-saved-0 /* keep */");
    expect(result).toContain("--b: var(--a, covel-saved-0 1s);");
    expect(result).toContain(
      "animation: var(--a, covel-saved-0/* keep */ 2s ease);",
    );
    expect(result).toContain("animation-name: var(--name, covel-saved-0);");
  });

  it("rejects a mismatched source id and unscoped source styles", () => {
    expect(() =>
      deriveThemeCss('html[data-theme="other"] {}', "source", "saved"),
    ).toThrow(/mismatch/);
    expect(() =>
      deriveThemeCss(
        'html[data-theme="source"] {} body { color: red; }',
        "source",
        "saved",
      ),
    ).toThrow(/must be scoped/);
  });

  it("handles CSS escapes and priorities without requiring whitespace", () => {
    const result = deriveThemeCss(
      String.raw`
@keyframes p\75 lse { from { opacity: 0; } }
html[data-theme="source"] {
  animation-name: p\75 lse!important;
  animation: var(--motion, pulse 2s)!important;
  --motion: p\75 lse 1s !important;
}`,
      "source",
      "saved",
    );
    expect(result).toContain("@keyframes covel-saved-0");
    expect(result).toContain("animation-name: covel-saved-0!important;");
    expect(result).toContain(
      "animation: var(--motion, covel-saved-0 2s)!important;",
    );
    expect(result).toContain("--motion: covel-saved-0 1s !important;");
  });
});
