import { describe, expect, it } from "vitest";
import { parseImportedThemeFile } from "../validate.js";

describe("parseImportedThemeFile", () => {
  it("parses css themes by extracting the data-theme id", () => {
    const payload = parseImportedThemeFile(
      `
      html[data-theme="cinder"] {
        --color-background: #10141c;
      }

      html[data-theme="cinder"].dark {
        --color-background: #090b10;
      }
      `,
      "cinder.css",
    );

    expect(payload.theme.id).toBe("cinder");
    expect(payload.theme.source).toBe("custom");
    expect(payload.theme.schemes).toEqual(["light", "dark"]);
  });

  it("parses json theme packages", () => {
    const payload = parseImportedThemeFile(
      JSON.stringify({
        id: "sunfall",
        label: {
          "zh-CN": "落日",
          "en-US": "Sunfall",
        },
        schemes: ["light"],
        cssText: 'html[data-theme="sunfall"] { --color-background: #f7e8d5; }',
      }),
      "sunfall.theme.json",
    );

    expect(payload.theme.id).toBe("sunfall");
    expect(payload.theme.schemes).toEqual(["light"]);
    expect(payload.theme.cssText).toContain('data-theme="sunfall"');
  });

  it("rejects css without a theme selector", () => {
    expect(() =>
      parseImportedThemeFile(".panel { color: red; }", "broken.css"),
    ).toThrow(/data-theme/);
  });

  it("rejects css files that mix multiple theme ids", () => {
    expect(() =>
      parseImportedThemeFile(
        `
        html[data-theme="one"] { --color-background: red; }
        html[data-theme="two"] { --color-background: blue; }
        `,
        "mixed.css",
      ),
    ).toThrow(/exactly one data-theme id/);
  });

  it("reports light-only when no dark-scoped selector is present", () => {
    const payload = parseImportedThemeFile(
      `
      html[data-theme="linen"] {
        --color-background: #faf5ea;
      }
      `,
      "linen.css",
    );

    expect(payload.theme.schemes).toEqual(["light"]);
  });

  // Validation used to require only that *one* scoped selector existed and
  // silently ignored the rest, so a theme could ship global rules that applied
  // to the whole app.
  it("rejects a rule that escapes the theme's data-theme scope", () => {
    expect(() =>
      parseImportedThemeFile(
        `
        html[data-theme="linen"] { --color-background: #faf5ea; }
        * { display: none !important; }
        `,
        "linen.css",
      ),
    ).toThrow(/must be scoped/);
  });

  it("rejects @import (remote fetch / beacon vector)", () => {
    expect(() =>
      parseImportedThemeFile(
        `
        @import url("https://example.com/track.css");
        html[data-theme="linen"] { --color-background: #faf5ea; }
        `,
        "linen.css",
      ),
    ).toThrow(/@import/);
  });

  // The scope scan reads whatever sits in front of a `{` as the selector, so a
  // leading comment block would be mistaken for an unscoped selector and reject
  // every real-world theme file. Every bundled theme starts with one.
  it("does not mistake a leading comment block for an unscoped selector", () => {
    const payload = parseImportedThemeFile(
      `
      /* ───────────────────────────────
         Linen — warm neutral
         ─────────────────────────────── */
      html[data-theme="linen"] { --color-background: #faf5ea; }
      /* Accent tweaks */
      html[data-theme="linen"] .badge { color: red; }
      `,
      "linen.css",
    );

    expect(payload.theme.id).toBe("linen");
  });

  // Each of these was a real defect in the first version of the scanner: two
  // false rejections of valid CSS and three bypasses.
  it("allows @keyframes — `from`/`to` are not selectors", () => {
    const payload = parseImportedThemeFile(
      `
      html[data-theme="linen"] { --bg: #fff; animation: pulse 1s; }
      @keyframes pulse { from { opacity: 0.5 } to { opacity: 1 } }
      `,
      "linen.css",
    );
    expect(payload.theme.id).toBe("linen");
  });

  it("allows @import mentioned inside a comment", () => {
    expect(() =>
      parseImportedThemeFile(
        `/* dropped the old @import */ html[data-theme="linen"] { --bg: #fff; }`,
        "linen.css",
      ),
    ).not.toThrow();
  });

  it("allows whitespace inside the attribute selector", () => {
    expect(() =>
      parseImportedThemeFile(
        `html[data-theme = "linen"] { --bg: #fff; }`,
        "linen.css",
      ),
    ).not.toThrow();
  });

  it("is not fooled by a brace inside a declaration string", () => {
    expect(() =>
      parseImportedThemeFile(
        `html[data-theme="linen"] a::before { content: "{"; }
         * { display: none !important; }`,
        "linen.css",
      ),
    ).toThrow(/must be scoped/);
  });

  it("is not fooled by a rule buried in nested at-rules", () => {
    expect(() =>
      parseImportedThemeFile(
        `html[data-theme="linen"] { --bg: #fff; }
         @media all { @media all { * { display: none !important; } } }`,
        "linen.css",
      ),
    ).toThrow(/must be scoped/);
  });

  it("is not fooled by the scope token appearing inside :not()", () => {
    expect(() =>
      parseImportedThemeFile(
        `html[data-theme="linen"] { --bg: #fff; }
         *:not([data-theme="linen"]) { display: none !important; }`,
        "linen.css",
      ),
    ).toThrow(/must be scoped/);
  });

  it("allows scoped rules nested inside at-rules and nested blocks", () => {
    const payload = parseImportedThemeFile(
      `
      @media (prefers-reduced-motion: reduce) {
        html[data-theme="linen"] { --motion: none; }
      }
      html[data-theme="linen"] {
        --color-background: #faf5ea;
        & .panel { color: red; }
      }
      html[data-theme="linen"].dark { --color-background: #1a1a1a; }
      `,
      "linen.css",
    );

    expect(payload.theme.id).toBe("linen");
    expect(payload.theme.schemes).toEqual(["light", "dark"]);
  });

  it("rejects json themes when cssText targets a different id", () => {
    expect(() =>
      parseImportedThemeFile(
        JSON.stringify({
          id: "sunfall",
          label: "Sunfall",
          cssText:
            'html[data-theme="other-theme"] { --color-background: #f7e8d5; }',
        }),
        "sunfall.theme.json",
      ),
    ).toThrow(/matches "sunfall"/);
  });
});
