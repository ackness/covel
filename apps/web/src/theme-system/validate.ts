import { z } from "zod";
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

function analyzeThemeSelectors(cssText: string): ThemeSelectorInfo {
  const ids: string[] = [];
  const darkIds: string[] = [];
  const selectorPattern = /([^{}]+)\{/g;
  let match: RegExpExecArray | null;

  while ((match = selectorPattern.exec(cssText))) {
    const selectorList = match[1] ?? "";
    for (const selector of selectorList.split(",")) {
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
 * Only the braces: a string's contents must survive, because the scope token
 * itself lives inside one (`[data-theme="paper"]`). But an unbalanced brace in
 * a declaration (`content: "{"`) would desync the depth tracking and make every
 * later rule look nested — and therefore skipped.
 */
function blankNonCode(cssText: string): string {
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
      let j = i + 1;
      while (j < cssText.length && cssText[j] !== quote) {
        if (cssText[j] === "\\") j++;
        else if (cssText[j] === "{" || cssText[j] === "}") out[j] = " ";
        j++;
      }
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
  const css = blankNonCode(cssText);
  // After blanking, so an `@import` mentioned in a comment doesn't trip it.
  if (AT_IMPORT_PATTERN.test(css)) {
    throw new Error("Theme CSS must not use @import.");
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

    for (const selector of prelude.split(",")) {
      const trimmed = selector.trim();
      if (!trimmed) continue;
      if (!scopePattern.test(stripFunctionalArgs(trimmed))) {
        throw new Error(
          `Every theme rule must be scoped to [data-theme="${themeId}"] — found "${trimmed.slice(0, 60)}".`,
        );
      }
    }
  }
}

function assertThemeCssMatchesId(cssText: string, themeId: string): void {
  const { ids } = analyzeThemeSelectors(cssText);
  if (ids.length === 0) {
    throw new Error(
      'Theme CSS must include a selector like html[data-theme="your-theme"].',
    );
  }
  if (ids.length > 1 || ids[0] !== themeId) {
    throw new Error(
      `Theme CSS must use exactly one data-theme id that matches "${themeId}".`,
    );
  }
}

function parseCssTheme(text: string, fileName: string): ImportedThemePayload {
  const { ids } = analyzeThemeSelectors(text);
  if (ids.length === 0) {
    throw new Error(
      'Theme CSS must include a selector like html[data-theme="your-theme"].',
    );
  }

  if (ids.length > 1) {
    throw new Error("Theme CSS must use exactly one data-theme id.");
  }

  const id = themeIdSchema.parse(ids[0]);
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
  const parsed = jsonThemeSchema.parse(JSON.parse(text));
  assertThemeCssMatchesId(parsed.cssText, parsed.id);
  assertThemeCssIsScoped(parsed.cssText, parsed.id);
  const theme: ThemeDefinition = {
    id: parsed.id,
    label: parsed.label,
    source: "custom",
    schemes: parsed.schemes?.length ? parsed.schemes : ["light", "dark"],
    description: parsed.description,
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
