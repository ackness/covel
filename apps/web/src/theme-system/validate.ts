import { BUILTIN_THEME_IDS } from "./builtins.js";
import { ThemeImportError } from "./import-error.js";
import { z } from "zod";
import { themeLayoutSpecSchema } from "./layout.js";
import type {
  ImportedThemePayload,
  ThemeDefinition,
  ThemeScheme,
} from "./types.js";

const themeIdSchema = z
  .string()
  .trim()
  .min(2)
  .max(48)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "Theme id must use lowercase letters, numbers, and hyphens.",
  );

const jsonThemeSchema = z.object({
  id: themeIdSchema,
  label: z.union([z.string(), z.record(z.string(), z.string())]),
  cssText: z.string().min(1),
  schemes: z.array(z.enum(["light", "dark"])).optional(),
  description: z
    .union([z.string(), z.record(z.string(), z.string())])
    .optional(),
  layout: themeLayoutSpecSchema.optional(),
  group: themeIdSchema.optional(),
  groupLabel: z
    .union([z.string(), z.record(z.string(), z.string())])
    .optional(),
});

const THEME_ID_PATTERN = /data-theme\s*=\s*["']([a-z0-9-]+)["']/g;

interface ThemeSelectorInfo {
  readonly ids: readonly string[];
  readonly darkIds: readonly string[];
}

function inferLabelFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  return base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Commas in functional pseudos, attributes and strings stay inside their selector. */
export function splitSelectorList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote = "";
  for (let index = 0; index < value.length; index++) {
    const char = value.charAt(index);
    if (char === "\\") {
      index++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") parentheses++;
    if (char === ")") parentheses--;
    if (char === "[") brackets++;
    if (char === "]") brackets--;
    if (char === "," && parentheses === 0 && brackets === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function importedThemeId(value: unknown): string {
  const result = themeIdSchema.safeParse(value);
  if (!result.success) throw new ThemeImportError("invalid-id");
  if (BUILTIN_THEME_IDS.has(result.data))
    throw new ThemeImportError("builtin-id", { id: result.data });
  return result.data;
}

function analyzeThemeSelectors(cssText: string): ThemeSelectorInfo {
  const ids: string[] = [];
  const darkIds: string[] = [];
  const selectorPattern = /([^{}]+)\{/g;
  const code = blankCssNonCode(cssText);
  let match: RegExpExecArray | null;

  while ((match = selectorPattern.exec(code))) {
    const selectorList = match[1] ?? "";
    for (const selector of splitSelectorList(selectorList)) {
      const idMatch = selector.match(THEME_ID_PATTERN);
      if (!idMatch) continue;
      for (const token of idMatch) {
        const id = token.match(/["']([a-z0-9-]+)["']/)?.[1];
        if (!id) continue;
        ids.push(id);
        if (
          /\bhtml\b[^{,]*\.dark|\.[\w-]*dark[\w-]*[^{,]*\bhtml\b/.test(selector)
        ) {
          darkIds.push(id);
        }
      }
    }
  }

  return {
    ids: [...new Set(ids)],
    darkIds: [...new Set(darkIds)],
  };
}

function detectSchemes(
  cssText: string,
  themeId: string,
): readonly ThemeScheme[] {
  const { darkIds } = analyzeThemeSelectors(cssText);
  return darkIds.includes(themeId) ? ["light", "dark"] : ["light"];
}

const AT_IMPORT_PATTERN = /@import\b/i;

/**
 * At-rules whose inner blocks are keyframe/descriptor lists, not selectors.
 * `from`, `to`, `0%` and `src:` are not elements and must not be scope-checked.
 */
const NON_SELECTOR_AT_RULES = new Set([
  "keyframes",
  "font-face",
  "counter-style",
  "font-feature-values",
  "property",
  "page",
]);

/**
 * Neutralise comments entirely, and braces *inside string literals*, preserving
 * length so offsets still line up.
 *
 * By default only braces are blanked in strings: their contents must survive,
 * because the scope token
 * itself lives inside one (`[data-theme="paper"]`). But an unbalanced brace in
 * a declaration (`content: "{"`) would desync the depth tracking and make every
 * later rule look nested — and therefore skipped. Rule rewriting can opt into
 * blanking entire strings to locate punctuation without changing offsets.
 */
export function blankCssNonCode(cssText: string, blankStrings = false): string {
  const out = cssText.split("");
  for (let i = 0; i < cssText.length; i++) {
    if (cssText[i] === "/" && cssText[i + 1] === "*") {
      const end = cssText.indexOf("*/", i + 2);
      const stop = end === -1 ? cssText.length : end + 2;
      for (let j = i; j < stop; j++) if (out[j] !== "\n") out[j] = " ";
      i = stop - 1;
      continue;
    }
    if (cssText[i] === '"' || cssText[i] === "'") {
      const quote = cssText[i];
      if (blankStrings) out[i] = " ";
      let j = i + 1;
      while (j < cssText.length && cssText[j] !== quote) {
        if (blankStrings || cssText[j] === "{" || cssText[j] === "}")
          out[j] = " ";
        if (cssText[j] === "\\") {
          if (blankStrings && j + 1 < cssText.length) out[j + 1] = " ";
          j++;
        }
        j++;
      }
      if (blankStrings && j < cssText.length) out[j] = " ";
      i = j;
      continue;
    }
  }
  return out.join("");
}

/** Drop functional-pseudo arguments so `:not([data-theme="x"])` can't satisfy the scope check. */
function stripFunctionalArgs(selector: string): string {
  let out = selector;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/\([^()]*\)/g, "()");
  } while (out !== previous);
  return out;
}

/**
 * Reject rules that escape the theme's own `data-theme` scope.
 *
 * NOT a sandbox, and deliberately not sold as one: a theme the player selected
 * can restyle the whole app through a perfectly scoped
 * `html[data-theme="x"] * { … }`, so no selector rule can prevent that. The
 * actual containment is that only the *selected* custom theme is mounted
 * (`registry.ts`). This check exists to catch honest authoring mistakes early
 * with a clear message, which makes a false rejection worse than a miss — hence
 * strings/comments are blanked and keyframe blocks are skipped rather than
 * guessed at.
 */
function assertThemeCssIsScoped(cssText: string, themeId: string): void {
  const css = blankCssNonCode(cssText);
  // After blanking, so an `@import` mentioned in a comment doesn't trip it.
  if (AT_IMPORT_PATTERN.test(css)) {
    throw new ThemeImportError("import-rule");
  }

  const scopePattern = new RegExp(
    `\\[\\s*data-theme\\s*=\\s*["']${themeId}["']\\s*\\]`,
  );
  // Stack of enclosing blocks: an at-rule name, or "" for a style rule.
  const stack: string[] = [];
  let selectorStart = 0;

  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "}") {
      stack.pop();
      selectorStart = i + 1;
      continue;
    }
    if (ch === ";" && stack.length === 0) {
      selectorStart = i + 1;
      continue;
    }
    if (ch !== "{") continue;

    const prelude = css.slice(selectorStart, i).trim();
    selectorStart = i + 1;

    if (prelude.startsWith("@")) {
      stack.push(prelude.slice(1).split(/[\s(]/, 1)[0]?.toLowerCase() ?? "");
      continue;
    }

    // Already inside a style rule → nested, so inherently scoped. Inside a
    // keyframe/descriptor at-rule → not a selector at all.
    const enclosing = stack[stack.length - 1];
    const insideStyleRule = stack.includes("");
    const insideNonSelectorAtRule =
      enclosing !== undefined && NON_SELECTOR_AT_RULES.has(enclosing);
    stack.push("");
    if (insideStyleRule || insideNonSelectorAtRule || !prelude) continue;

    for (const selector of splitSelectorList(prelude)) {
      const trimmed = selector.trim();
      if (!trimmed) continue;
      if (!scopePattern.test(stripFunctionalArgs(trimmed))) {
        throw new ThemeImportError("escapes-scope", {
          id: themeId,
          selector: trimmed.slice(0, 60),
        });
      }
    }
  }
}

function assertThemeCssMatchesId(cssText: string, themeId: string): void {
  const { ids } = analyzeThemeSelectors(cssText);
  if (ids.length === 0) {
    throw new ThemeImportError("missing-scope");
  }
  if (ids.length > 1 || ids[0] !== themeId) {
    throw new ThemeImportError("id-mismatch", { id: themeId });
  }
}

function parseCssTheme(text: string, fileName: string): ImportedThemePayload {
  const { ids } = analyzeThemeSelectors(text);
  if (ids.length === 0) {
    throw new ThemeImportError("missing-scope");
  }

  if (ids.length > 1) {
    throw new ThemeImportError("multiple-ids");
  }

  const id = importedThemeId(ids[0]);
  assertThemeCssIsScoped(text, id);
  const schemes = detectSchemes(text, id);
  const theme: ThemeDefinition = {
    id,
    label: inferLabelFromFileName(fileName) || id,
    source: "custom",
    schemes,
    cssText: text,
  };

  return { theme, fileName };
}

function parseJsonTheme(text: string, fileName: string): ImportedThemePayload {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ThemeImportError("invalid-json");
  }
  const result = jsonThemeSchema.safeParse(value);
  if (!result.success) throw new ThemeImportError("invalid-manifest");
  const parsed = result.data;
  importedThemeId(parsed.id);
  assertThemeCssMatchesId(parsed.cssText, parsed.id);
  assertThemeCssIsScoped(parsed.cssText, parsed.id);
  const theme: ThemeDefinition = {
    id: parsed.id,
    label: parsed.label,
    source: "custom",
    schemes: parsed.schemes?.length ? parsed.schemes : ["light", "dark"],
    description: parsed.description,
    layout: parsed.layout,
    group: parsed.group,
    groupLabel: parsed.groupLabel,
    cssText: parsed.cssText,
  };
  return { theme, fileName };
}

export function parseImportedThemeFile(
  text: string,
  fileName: string,
): ImportedThemePayload {
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".json") || lowerName.endsWith(".theme")) {
    return parseJsonTheme(text, fileName);
  }

  return parseCssTheme(text, fileName);
}

/** Validate a known source before deriving it; builtin sources are allowed here. */
export function validateThemeCss(cssText: string, themeId: string): void {
  assertThemeCssMatchesId(cssText, themeId);
  assertThemeCssIsScoped(cssText, themeId);
}
