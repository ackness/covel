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
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Theme id must use lowercase letters, numbers, and hyphens.");

const jsonThemeSchema = z.object({
  id: themeIdSchema,
  label: z.union([z.string(), z.record(z.string(), z.string())]),
  cssText: z.string().min(1),
  schemes: z.array(z.enum(["light", "dark"])).optional(),
  description: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
});

const THEME_ID_PATTERN = /data-theme\s*=\s*["']([a-z0-9-]+)["']/g;

function inferLabelFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  return base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function detectSchemes(cssText: string): readonly ThemeScheme[] {
  return cssText.includes(".dark") ? ["light", "dark"] : ["light"];
}

function parseCssTheme(
  text: string,
  fileName: string,
): ImportedThemePayload {
  const ids = [...text.matchAll(THEME_ID_PATTERN)]
    .map((match) => match[1])
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error(
      "Theme CSS must include a selector like html[data-theme=\"your-theme\"].",
    );
  }

  const uniqueIds = [...new Set(ids)];
  const id = themeIdSchema.parse(uniqueIds[0]);
  const schemes = detectSchemes(text);
  const theme: ThemeDefinition = {
    id,
    label: inferLabelFromFileName(fileName) || id,
    source: "custom",
    schemes,
    cssText: text,
  };

  return { theme, fileName };
}

function parseJsonTheme(
  text: string,
  fileName: string,
): ImportedThemePayload {
  const parsed = jsonThemeSchema.parse(JSON.parse(text));
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
