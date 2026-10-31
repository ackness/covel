import type { CssNodePlain } from "css-tree";
import { fromPlainObject, generate, parse, toPlainObject } from "css-tree";
import { pluginAssetUrl } from "./plugin-frame.js";
import {
  MAX_PLUGIN_THEME_CSS_BYTES,
  PLUGIN_THEME_TOKENS,
  pluginThemeAssetsSchema,
  type PluginThemeAssets,
} from "./schemas/plugin-theme.js";

export type PluginThemePart = "story" | "dialogue" | "surface";
export interface PluginThemeCssContext {
  readonly pluginId: string;
  /** Host-generated SHA-256 identity, never authored. */
  readonly scope: string;
  readonly assets?: PluginThemeAssets;
}
export interface PluginThemeIssue {
  readonly path: string;
  readonly message: string;
  readonly file?: string;
}
export type PluginThemeCssResult =
  | { success: true; css: string }
  | { success: false; issues: PluginThemeIssue[] };

// A narrow view of the parser's plain AST. Every consumed node is checked by
// type and shape below; unknown and Raw nodes have no accepted branch.
interface Node {
  type: string;
  children?: Node[];
  name?: string | Node;
  value?: string | Node;
  unit?: string;
  prelude?: Node;
  block?: Node;
  property?: string;
  important?: boolean;
  matcher?: string;
  flags?: string | null;
  loc?: { start: { offset: number }; end: { offset: number } };
}
const parts: readonly string[] = ["story", "dialogue", "surface"];
const palette = new Set<string>(PLUGIN_THEME_TOKENS);
const encoder = new TextEncoder();
function fail(path: string, message: string): never {
  throw { path, message };
}
const scopeSelector = (scope: string, part: PluginThemePart) =>
  `[data-covel-theme-scope="${scope}"][data-covel-theme-part="${part}"]`;

/** Refuse incomplete delimiters and escapes; comments are not policy input. */
function checkSyntax(source: string): void {
  const stack: string[] = [];
  let quote = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === "\\") fail("css", "CSS escapes are not supported");
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\n" || char === "\r" || char === "\f")
        fail("css", "invalid CSS string");
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) fail("css", "unterminated CSS comment");
      index = end + 1;
    } else if (char === '"' || char === "'") quote = char;
    else if ("{([".includes(char)) stack.push(char);
    else if (
      "})]".includes(char) &&
      stack.pop() !==
        ({ "}": "{", ")": "(", "]": "[" } as Record<string, string>)[char]
    )
      fail("css", "unbalanced CSS delimiters");
  }
  if (quote || stack.length) fail("css", "incomplete CSS syntax");
}

function selectorPart(
  node: Node,
  scope: string,
  resolved: boolean,
  at: string,
): PluginThemePart {
  if (node.type !== "Selector" || !node.children)
    fail(at, "expected a symbolic theme target");
  if (!resolved) {
    const [single] = node.children;
    if (
      node.children.length === 1 &&
      single?.type === "ClassSelector" &&
      typeof single.name === "string" &&
      parts.includes(single.name)
    )
      return single.name as PluginThemePart;
  } else {
    for (const part of parts) {
      const expected = toPlainObject(
        parse(scopeSelector(scope, part as PluginThemePart), {
          context: "selector",
        }),
      ) as Node;
      const attributes = node.children;
      if (
        attributes.length === 2 &&
        attributes.every((attr, index) => {
          const other = expected.children?.[index];
          return (
            attr.type === "AttributeSelector" &&
            attr.matcher === "=" &&
            !attr.flags &&
            typeof attr.name === "object" &&
            attr.name.type === "Identifier" &&
            attr.name.name === (other?.name as Node)?.name &&
            typeof attr.value === "object" &&
            attr.value.type === "String" &&
            attr.value.value === (other?.value as Node)?.value
          );
        })
      )
        return part as PluginThemePart;
    }
  }
  return fail(at, "selector must be exactly .story, .dialogue or .surface");
}

function bitmapUrl(
  value: string,
  context: PluginThemeCssContext,
  resolved: boolean,
  at: string,
): string {
  const assets = context.assets;
  if (!assets) return fail(at, "background URL needs an indexed bitmap root");
  if (resolved) {
    const file = assets.files.find(
      (file) =>
        pluginAssetUrl(context.pluginId, assets.digest, file.path) === value,
    );
    if (file) return value;
    return fail(at, "URL must match the exact owner, digest and listed bitmap");
  }
  // Decode percent encoding once, reject separators and ambiguous re-encoding,
  // then validate the decoded path. No browser URL/base resolution is involved.
  if (/%(?:2f|5c|00)/i.test(value))
    return fail(at, "encoded separators are not allowed");
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fail(at, "malformed bitmap path encoding");
  }
  if (/[\\\0:%?#]/.test(decoded))
    return fail(at, "expected an asset-root-relative bitmap path");
  const relative = decoded.startsWith("./") ? decoded.slice(2) : decoded;
  if (
    !relative ||
    relative
      .split("/")
      .some(
        (segment) =>
          !segment ||
          segment.startsWith(".") ||
          segment === "node_modules" ||
          segment === "__covel__",
      )
  )
    return fail(at, "expected an asset-root-relative bitmap path");
  if (!assets.files.some((file) => file.path === relative))
    return fail(at, "bitmap is not in the published listing");
  return pluginAssetUrl(context.pluginId, assets.digest, relative);
}

function declarationValue(
  property: string,
  value: Node,
  part: PluginThemePart,
  context: PluginThemeCssContext,
  resolved: boolean,
  at: string,
): string {
  const nodes = value.children;
  if (value.type !== "Value" || !nodes || nodes.length !== 1)
    return fail(at, "expected one allowed value");
  const node = nodes[0]!;
  const name = typeof node.name === "string" ? node.name.toLowerCase() : "";
  const keyword = (allowed: readonly string[]) =>
    node.type === "Identifier" && allowed.includes(name)
      ? name
      : fail(at, "value is not allowed for this property");
  const number = (unit: string, min: number, max: number, integer = false) => {
    if (
      node.type !== (unit ? "Dimension" : "Number") ||
      (unit && node.unit?.toLowerCase() !== unit) ||
      typeof node.value !== "string"
    )
      return fail(at, "expected one bounded numeric value");
    const numeric = Number(node.value);
    if (
      !Number.isFinite(numeric) ||
      numeric < min ||
      numeric > max ||
      (integer && !Number.isInteger(numeric))
    )
      return fail(at, "numeric value is outside its allowed range");
    return `${numeric}${unit}`;
  };
  if (
    [
      "background-color",
      "border-color",
      ...(part === "surface" ? [] : ["color"]),
    ].includes(property)
  ) {
    const token = node.children?.[0];
    if (
      node.type === "Function" &&
      name === "var" &&
      node.children?.length === 1 &&
      token?.type === "Identifier" &&
      typeof token.name === "string" &&
      palette.has(token.name)
    )
      return `var(${token.name})`;
    return fail(
      at,
      "color must reference exactly one allowed palette token without fallback",
    );
  }
  if (property === "border-style")
    return keyword(["none", "solid", "dashed", "dotted"]);
  if (property === "border-width") return number("px", 0, 4);
  if (property === "border-radius") return number("px", 0, 24);
  if (part !== "surface") {
    if (property === "font-family")
      return keyword(["serif", "sans-serif", "monospace"]);
    if (property === "font-weight") return number("", 400, 700, true);
    if (property === "font-style") return keyword(["normal", "italic"]);
    if (property === "font-size") return number("rem", 0.875, 1.5);
    if (property === "line-height") return number("", 1.2, 2.4);
    if (property === "letter-spacing") return number("em", 0, 0.08);
  } else {
    if (property === "background-repeat")
      return keyword(["repeat", "no-repeat"]);
    if (property === "background-size")
      return keyword(["auto", "cover", "contain"]);
    if (property === "background-image") {
      if (node.type === "Identifier") return keyword(["none"]);
      if (node.type === "Url" && typeof node.value === "string")
        return `url("${bitmapUrl(node.value, context, resolved, at)}")`;
    }
  }
  return fail(at, "property is not allowed on this theme target");
}

function compile(
  css: string,
  context: PluginThemeCssContext,
  resolved: boolean,
  outputScope = context.scope,
): PluginThemeCssResult {
  try {
    if (
      !/^[a-z][a-z0-9-]*$/.test(context.pluginId) ||
      !/^[a-f0-9]{64}$/.test(context.scope) ||
      !/^[a-f0-9]{64}$/.test(outputScope) ||
      (context.assets &&
        !pluginThemeAssetsSchema.safeParse(context.assets).success)
    )
      fail("css", "invalid host theme context");
    if (
      !css.trim() ||
      encoder.encode(css).length >
        (resolved ? 512 * 1024 : MAX_PLUGIN_THEME_CSS_BYTES)
    )
      fail("css", "CSS must be nonempty and at most 64 KiB");
    checkSyntax(css);
    const ast = toPlainObject(
      parse(css, {
        positions: true,
        onParseError: () => fail("css", "CSS parse recovery is forbidden"),
      }),
    ) as Node;
    if (
      ast.type !== "StyleSheet" ||
      !ast.children?.length ||
      ast.children.length > 128
    )
      fail("css", "expected 1 to 128 style rules");
    const output: string[] = [];
    let total = 0;
    for (const [index, rule] of ast.children.entries()) {
      const at = `rules[${index}]`;
      if (
        rule.type !== "Rule" ||
        rule.prelude?.type !== "SelectorList" ||
        !rule.prelude.children?.length ||
        rule.block?.type !== "Block"
      )
        fail(
          at,
          "only style rules are allowed; at-rules and nesting are forbidden",
        );
      const targets = [
        ...new Set(
          rule.prelude.children.map((node) =>
            selectorPart(node, context.scope, resolved, `${at}.selector`),
          ),
        ),
      ];
      const declarations = rule.block.children;
      if (
        !declarations?.length ||
        declarations.length > 32 ||
        (total += declarations.length) > 2048
      )
        fail(at, "declaration count exceeds the allowed bounds");
      const values: string[] = [];
      for (const [index, declaration] of declarations.entries()) {
        const field = `${at}.declarations[${index}]`;
        if (
          declaration.type !== "Declaration" ||
          declaration.important ||
          typeof declaration.property !== "string" ||
          typeof declaration.value !== "object"
        )
          fail(field, "expected an allowed declaration without !important");
        const value = declaration.value;
        if (
          !value.loc ||
          !declaration.loc ||
          declaration.loc.end.offset -
            css.indexOf(":", declaration.loc.start.offset) -
            1 >
            (resolved ? 4096 : 256)
        )
          fail(field, "value exceeds 256 characters");
        const property = declaration.property.toLowerCase();
        const canonical = targets.map((part) =>
          declarationValue(property, value, part, context, resolved, field),
        );
        values.push(`${property}:${canonical[0]!}`);
      }
      output.push(
        `${targets.map((part) => scopeSelector(outputScope, part)).join(",")}{${values.join(";")}}`,
      );
    }
    // Generate from freshly constructed, validated selectors and values only.
    const generated = toPlainObject(parse(output.join(""))) as Node;
    const quoteUrls = (node: Node): Node => {
      // Own URLs may contain apostrophes or parentheses. A quoted String
      // node preserves them without introducing escapes into the CSS language.
      if (node.type === "Url")
        return {
          type: "Function",
          name: "url",
          children: [{ type: "String", value: node.value }],
        };
      if (node.children) node.children = node.children.map(quoteUrls);
      if (node.prelude) node.prelude = quoteUrls(node.prelude);
      if (node.block) node.block = quoteUrls(node.block);
      if (typeof node.value === "object") node.value = quoteUrls(node.value);
      return node;
    };
    return {
      success: true,
      css: generate(fromPlainObject(quoteUrls(generated) as CssNodePlain)),
    };
  } catch (error) {
    const issue = error as Partial<PluginThemeIssue>;
    return {
      success: false,
      issues: [
        {
          path: typeof issue?.path === "string" ? issue.path : "css",
          message:
            typeof issue?.path === "string" && typeof issue.message === "string"
              ? issue.message
              : "invalid CSS syntax",
        },
      ],
    };
  }
}

export function compilePluginThemeCss(
  css: string,
  context: PluginThemeCssContext,
): PluginThemeCssResult {
  return compile(css, context, false);
}
/** Revalidate the public DTO with the identical property and resource policy. */
export function validateCompiledPluginThemeCss(
  css: string,
  context: PluginThemeCssContext,
): PluginThemeCssResult {
  return compile(css, context, true);
}

/** Revalidate before binding a published stylesheet to one host mount. */
export function scopeCompiledPluginThemeCss(
  css: string,
  context: PluginThemeCssContext,
  mountScope: string,
): PluginThemeCssResult {
  return compile(css, context, true, mountScope);
}
