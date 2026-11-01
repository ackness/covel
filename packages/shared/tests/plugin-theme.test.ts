import { pluginUiPathsSchema } from "../src/schemas/plugin-schemas.js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  compilePluginThemeCss,
  scopeCompiledPluginThemeCss,
  validateCompiledPluginThemeCss,
  pluginThemeSpecSchema,
  resolvedPluginThemeSchema,
  resolvedPluginThemeEntrySchema,
  PLUGIN_THEME_TOKENS,
} from "../src/index.js";
const scope = "a".repeat(64);
const assets = {
  digest: "b".repeat(32),
  files: [{ path: "paper.png", mime: "image/png" as const, size: 24 }],
};
const context = { pluginId: "reading-pack", scope, assets };
const css = (source: string) => compilePluginThemeCss(source, context);
const selector = (part: string) =>
  `[data-covel-theme-scope="${scope}"][data-covel-theme-part="${part}"]`;
const spec = {
  id: "reading",
  label: "Reading",
  tokens: { light: { "--story-color": "#AbC" } },
};
it("accepts independent token and layout contributions and normalizes opaque colors", () => {
  expect(
    pluginThemeSpecSchema.parse(spec).tokens?.light?.["--story-color"],
  ).toBe("#aabbcc");
  for (const preset of ["classic", "book", "stage", "panel"])
    expect(
      pluginThemeSpecSchema.safeParse({
        id: "reading",
        label: "Reading",
        layout: { preset },
      }).success,
    ).toBe(true);
  expect(
    pluginUiPathsSchema.parse({ theme: ["./ui/theme.json"] }).theme,
  ).toEqual(["./ui/theme.json"]);
});
it.each([
  { specVersion: 2 },
  { id: "Upper" },
  { id: "a".repeat(65) },
  { label: "x".repeat(81) },
  { description: "x".repeat(241) },
  { tokens: {} },
  { tokens: { dark: {} } },
  { tokens: { light: { "--font-size": "#fff" } } },
  ...["#abcd", "#12345678", "red", "var(--story-color)", "#fff;", "url(x)"].map(
    (value) => ({ tokens: { light: { "--story-color": value } } }),
  ),
  ...[
    "../t.css",
    "/t.css",
    "https://x/t.css",
    "./.hidden/t.css",
    "ui/../t.css",
    "ui\\t.css",
    "ui/t.css?q",
    "ui/t.css#x",
    "ui/%2e/t.css",
  ].map((css) => ({ css })),
  { layout: { preset: "unknown" } },
  { layout: { preset: "book", nav: "top" } },
  ...[
    "view",
    "webview",
    "dataSource",
    "bridge",
    "scripts",
    "settings",
    "runtime",
    "cssText",
    "schemes",
  ].map((key) => ({ [key]: {} })),
])("rejects unsupported descriptor fields and values (%#)", (extra) => {
  expect(pluginThemeSpecSchema.safeParse({ ...spec, ...extra }).success).toBe(
    false,
  );
});
it("requires an appearance contribution and bounds manifest declarations", () => {
  expect(
    pluginThemeSpecSchema.safeParse({
      id: "reading",
      label: "Reading",
      assets: { root: "./art" },
    }).success,
  ).toBe(false);
  expect(
    pluginUiPathsSchema.safeParse({ theme: Array(8).fill("./theme.json") })
      .success,
  ).toBe(true);
  expect(
    pluginUiPathsSchema.safeParse({ theme: Array(9).fill("./theme.json") })
      .success,
  ).toBe(false);
});
it("uses tokens already present in the framework styles", () => {
  const source = ["index.css", "styles/layout.css"]
    .map((name) =>
      readFileSync(
        new URL(`../../../apps/web/src/${name}`, import.meta.url),
        "utf8",
      ),
    )
    .join("\n");
  for (const token of PLUGIN_THEME_TOKENS)
    expect(source, token).toContain(token);
});
const common: [string, string][] = [
  ["background-color", "var(--surface-story)"],
  ["border-color", "var(--rule-color)"],
  ["border-style", "none"],
  ["border-style", "solid"],
  ["border-style", "dashed"],
  ["border-style", "dotted"],
  ["border-width", "0px"],
  ["border-width", "4px"],
  ["border-radius", "0px"],
  ["border-radius", "24px"],
];
const text: [string, string][] = [
  ["color", "var(--story-color)"],
  ["font-family", "serif"],
  ["font-family", "sans-serif"],
  ["font-family", "monospace"],
  ["font-weight", "400"],
  ["font-weight", "700"],
  ["font-style", "normal"],
  ["font-style", "italic"],
  ["font-size", "0.875rem"],
  ["font-size", "1.5rem"],
  ["line-height", "1.2"],
  ["line-height", "2.4"],
  ["letter-spacing", "0em"],
  ["letter-spacing", "0.08em"],
];
const surface: [string, string][] = [
  ["background-image", "none"],
  ["background-image", 'url("paper.png")'],
  ["background-repeat", "repeat"],
  ["background-repeat", "no-repeat"],
  ["background-size", "auto"],
  ["background-size", "cover"],
  ["background-size", "contain"],
];
describe.each(["story", "dialogue", "surface"])("target %s", (target) => {
  it.each([...common, ...(target === "surface" ? surface : text)])(
    "accepts %s: %s",
    (property, value) => {
      const compiled = css(`.${target}{${property}:${value}}`);
      expect(compiled.success).toBe(true);
      if (compiled.success)
        expect(validateCompiledPluginThemeCss(compiled.css, context)).toEqual(
          compiled,
        );
    },
  );
});
it.each([
  ".host",
  "body",
  "#story",
  "*",
  "[data-story]",
  ".story .dialogue",
  ".story>.dialogue",
  ".story:hover",
  ".story::before",
  ".story.surface",
  ":is(.story)",
  ":where(.story)",
  ":not(.host)",
  ":has(.story)",
  "&",
  "|story",
  ".story,.host",
  ".Story",
  ".st\\6f ry",
])("refuses selector %s atomically", (selector) =>
  expect(css(`${selector}{border-style:solid}`).success).toBe(false),
);
it.each([
  "color:red",
  "color:var(--story-color,#fff)",
  "color:var(--unknown)",
  "color:VAR(--story-color,attr(x))",
  "color:url(paper.png)",
  "color:var(--story-color)!important",
  "-webkit-border-radius:2px",
  "--custom:#fff",
  "border-width:4.01px",
  "border-width:-1px",
  "border-width:0",
  "border-radius:24.1px",
  "border-style:double",
  "font-size:0.874rem",
  "font-size:1.501rem",
  "font-weight:399",
  "font-weight:701",
  "font-weight:400.5",
  "font-family:'serif'",
  "font-family:serif,monospace",
  "font-family:url(x)",
  "font-style:oblique",
  "line-height:1.19",
  "line-height:2.41",
  "letter-spacing:-0.01em",
  "letter-spacing:0.081em",
  "color:attr(secret)",
  "color:env(secret)",
  "color:expression(alert(1))",
  "border-width:calc(2px)",
  ...[
    "all",
    "content",
    "position",
    "top",
    "z-index",
    "display",
    "visibility",
    "opacity",
    "transform",
    "filter",
    "mask",
    "clip",
    "mix-blend-mode",
    "margin",
    "width",
    "overflow",
    "pointer-events",
    "cursor",
    "appearance",
    "animation",
    "transition",
    "counter-reset",
    "behavior",
    "-moz-binding",
  ].map((property) => `${property}:none`),
  "background-image:url(paper.png)",
  "background-repeat:repeat",
  "font-\\77 eight:400",
  "color:var(--story-color) garbage",
])("rejects forbidden story declaration %s", (declaration) =>
  expect(css(`.story{${declaration}}`).success).toBe(false),
);
it.each([
  '@import "x";',
  "@font-face{font-family:x;src:url(x)}",
  "@keyframes x{from{opacity:0}}",
  '@property --x{syntax:"*"}',
  "@layer x{.story{border-style:solid}}",
  "@scope (.story){.story{border-style:solid}}",
  "@media screen{.story{border-style:solid}}",
  "@supports(display:grid){.story{border-style:solid}}",
  ".story{.dialogue{color:var(--story-color)}}",
  ".story{color:}",
  ".story{color:red",
  ".story{color:var(--story-color)} trailing",
  ".story{broken}",
  ".story{color:var(--story-color); @bad x;}",
  "<!-- .story{border-style:solid} -->",
])("rejects at-rules, nesting and parser recovery (%#)", (source) =>
  expect(css(source).success).toBe(false),
);
it("ignores harmless comments and handles case only where CSS identifiers are case-insensitive", () => {
  expect(
    css(
      "/* url(https://bad) position:fixed @import */ .story,.dialogue{COLOR:VAR(--story-color);font-family:SERIF}",
    ),
  ).toEqual({
    success: true,
    css: `${selector("story")},${selector("dialogue")}{color:var(--story-color);font-family:serif}`,
  });
});
it.each([
  "https://example.com/a.png",
  "http://x/a.png",
  "//x/a.png",
  "data:image/png,foo",
  "blob:foo",
  "file:/foo",
  "javascript:foo",
  "/api/secret",
  "/api/media/a.png",
  "/worlds/a.png",
  "/plugin-assets/other/b/paper.png",
  "../paper.png",
  "nested/../paper.png",
  ".hidden.png",
  "node_modules/paper.png",
  "__covel__/paper.png",
  "paper.png?x",
  "paper.png#x",
  "paper.png%00",
  "%2e%2e/paper.png",
  "a%2fb.png",
  "a%5Cb.png",
  "paper%",
  "paper%2.png",
  "paper%252e.png",
  "paper.png/evil",
  "paper.png-evil",
  "missing.png",
  "a\\b.png",
  "\\70 aper.png",
])("refuses bitmap URL %s", (value) =>
  expect(css(`.surface{background-image:url("${value}")}`).success).toBe(false),
);
it("publishes exactly the indexed own URL and host scope for quoted and unquoted URLs", () => {
  for (const value of [
    "url(paper.png)",
    "URL('paper.png')",
    'url("./paper.png")',
  ]) {
    const result = css(`.surface{background-image:${value}}`);
    expect(result).toEqual({
      success: true,
      css: `${selector("surface")}{background-image:url("/plugin-assets/reading-pack/${assets.digest}/paper.png")}`,
    });
  }
});
it.each([
  "url(var(--story-color))",
  "image-set(url(paper.png) 1x)",
  'url("paper.png") url("paper.png")',
  "attr(data-img)",
  "paint(x)",
  "element(#x)",
  "url(/*x*/paper.png)",
])("rejects unsupported URL/function structures %s", (value) =>
  expect(css(`.surface{background-image:${value}}`).success).toBe(false),
);
it("bounds bytes, rules, per-rule/total declarations and values without truncation", () => {
  expect(
    css(`/*${"x".repeat(65536)}*/.story{border-style:solid}`).success,
  ).toBe(false);
  expect(css(".story{border-style:solid}".repeat(128)).success).toBe(true);
  expect(css(".story{border-style:solid}".repeat(129)).success).toBe(false);
  expect(css(`.story{${"border-style:solid;".repeat(32)}}`).success).toBe(true);
  expect(css(`.story{${"border-style:solid;".repeat(33)}}`).success).toBe(
    false,
  );
  const rule = `.story{${"border-style:solid;".repeat(32)}}`;
  expect(css(rule.repeat(64)).success).toBe(true);
  expect(css(rule.repeat(65)).success).toBe(false);
  expect(css(`.story{border-style:/*${"x".repeat(256)}*/solid}`).success).toBe(
    false,
  );
  for (const source of ["", " ", "/*only comments*/"])
    expect(css(source).success).toBe(false);
});
it("revalidates public selector and exact resource ownership rather than URL prefixes", () => {
  const compiled = css(".surface{background-image:url(paper.png)}");
  expect(compiled.success).toBe(true);
  if (!compiled.success) return;
  const theme = {
    pluginId: context.pluginId,
    id: "reading",
    label: "Reading",
    contentHash: scope,
    assets,
    cssText: compiled.css,
  };
  expect(resolvedPluginThemeSchema.safeParse(theme).success).toBe(true);
  for (const [before, after] of [
    [context.pluginId, "foreign"],
    [assets.digest, "c".repeat(32)],
    ["paper.png", "paper.png-evil"],
    [scope, "d".repeat(64)],
  ])
    expect(
      resolvedPluginThemeSchema.safeParse({
        ...theme,
        cssText: compiled.css.replace(before!, after!),
      }).success,
    ).toBe(false);
  expect(
    resolvedPluginThemeSchema.safeParse({
      ...theme,
      cssText: ".story{border-style:solid}",
    }).success,
  ).toBe(false);
});

it("accepts all opaque palette tokens and bounds compiled descriptor size", () => {
  const light = Object.fromEntries(
    PLUGIN_THEME_TOKENS.map((token) => [token, "#fAf"]),
  );
  expect(
    pluginThemeSpecSchema.safeParse({ ...spec, tokens: { light } }).success,
  ).toBe(true);
  const label = Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [
      `en-${String(index).padStart(3, "0")}`,
      "字".repeat(80),
    ]),
  );
  expect(pluginThemeSpecSchema.safeParse({ ...spec, label }).success).toBe(
    false,
  );
});

it("binds discovery groups to each nested owner and unique local ID", () => {
  const theme = {
    pluginId: "reader",
    id: "reading",
    label: "Reading",
    contentHash: scope,
    layout: { preset: "book" as const },
  };
  expect(
    resolvedPluginThemeEntrySchema.safeParse({
      pluginId: "reader",
      specs: [theme],
    }).success,
  ).toBe(true);
  expect(
    resolvedPluginThemeEntrySchema.safeParse({
      pluginId: "foreign",
      specs: [theme],
    }).success,
  ).toBe(false);
  expect(
    resolvedPluginThemeEntrySchema.safeParse({
      pluginId: "reader",
      specs: [theme, theme],
    }).success,
  ).toBe(false);
});

it("bounds generated scope expansion by collapsing repeated valid targets", () => {
  const result = css(
    `${Array(9000).fill(".story").join(",")}{border-style:solid}`,
  );
  expect(result).toEqual({
    success: true,
    css: `${selector("story")}{border-style:solid}`,
  });
});

it("round-trips own bitmap filenames containing URL punctuation without CSS escapes", () => {
  const own = {
    ...context,
    assets: {
      ...assets,
      files: [{ ...assets.files[0]!, path: "paper's(1).png" }],
    },
  };
  const result = compilePluginThemeCss(
    `.surface{background-image:url("paper's(1).png")}`,
    own,
  );
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.css).toContain(
    `url("/plugin-assets/reading-pack/${assets.digest}/paper's(1).png")`,
  );
  expect(validateCompiledPluginThemeCss(result.css, own)).toEqual(result);
});

it("revalidates and rebinds accepted CSS to one host mount without changing resource ownership", () => {
  const compiled = css(
    ".story{color:var(--story-color)}.surface{background-image:url(paper.png)}",
  );
  expect(compiled.success).toBe(true);
  if (!compiled.success) return;
  const mount = "d".repeat(64);
  const rebound = scopeCompiledPluginThemeCss(compiled.css, context, mount);
  expect(rebound.success).toBe(true);
  if (!rebound.success) return;
  expect(rebound.css).toContain(`[data-covel-theme-scope="${mount}"]`);
  expect(rebound.css).not.toContain(`[data-covel-theme-scope="${scope}"]`);
  expect(rebound.css).toContain(
    `/plugin-assets/reading-pack/${assets.digest}/paper.png`,
  );
  expect(
    scopeCompiledPluginThemeCss(
      compiled.css,
      { ...context, scope: mount },
      scope,
    ).success,
  ).toBe(false);
  expect(
    scopeCompiledPluginThemeCss("html{position:fixed}", context, mount).success,
  ).toBe(false);
  expect(
    scopeCompiledPluginThemeCss(compiled.css, context, "bad").success,
  ).toBe(false);
});
