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
