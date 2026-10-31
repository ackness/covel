import { z } from "zod";
import { PLUGIN_VIEW_ID_PATTERN } from "./view-mode.js";
import { CURRENT_UI_SPEC_VERSION } from "./ui-spec.js";

export const THEME_LAYOUT_PRESET_IDS = [
  "classic",
  "book",
  "stage",
  "panel",
] as const;
export const PLUGIN_THEME_POLICY_VERSION = 1;
export const MAX_PLUGIN_THEME_SPEC_BYTES = 32 * 1024;
export const MAX_PLUGIN_THEME_CSS_BYTES = 64 * 1024;
export const MAX_PLUGIN_THEMES = 8;
export const MAX_PLUGIN_THEME_BITMAP_FILES = 32;
export const MAX_PLUGIN_THEME_BITMAP_BYTES = 8 * 1024 * 1024;
export const MAX_PLUGIN_THEME_BITMAP_FILE_BYTES = 2 * 1024 * 1024;
export const PLUGIN_THEME_TOKENS = [
  "--color-background",
  "--surface-page",
  "--surface-story",
  "--surface-elevated",
  "--color-foreground",
  "--story-color",
  "--color-muted-foreground",
  "--color-border",
  "--rule-color",
  "--accent-primary",
  "--color-primary-foreground",
  "--accent-success",
  "--accent-warning",
  "--accent-danger",
] as const;

/** Package paths never use URL syntax, hidden segments or parent traversal. */
export const pluginThemePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    const relative = value.startsWith("./") ? value.slice(2) : value;
    return (
      !/[\\\0:%?#]/.test(relative) &&
      relative
        .split("/")
        .every(
          (part) =>
            !!part &&
            !part.startsWith(".") &&
            part !== "node_modules" &&
            part !== "__covel__",
        ) &&
      !relative.startsWith("/")
    );
  }, "use a package-relative path without hidden or parent segments");

export const pluginThemeColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  .transform((value) => {
    const color = value.slice(1).toLowerCase();
    return `#${color.length === 3 ? [...color].map((c) => c + c).join("") : color}`;
  });
const tokenMap = z
  .partialRecord(z.enum(PLUGIN_THEME_TOKENS), pluginThemeColorSchema)
  .refine(
    (value) => Object.keys(value).length > 0,
    "token map must not be empty",
  );
export const pluginThemeTokensSchema = z
  .strictObject({ light: tokenMap.optional(), dark: tokenMap.optional() })
  .refine(
    (value) => value.light !== undefined || value.dark !== undefined,
    "tokens need a scheme",
  );
export const pluginThemeLayoutSchema = z.strictObject({
  preset: z.enum(THEME_LAYOUT_PRESET_IDS),
});
const text = (max: number) =>
  z.union([
    z.string().min(1).max(max),
    z
      .record(
        z.string().regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/),
        z.string().min(1).max(max),
      )
      .refine(
        (value) => Object.keys(value).length > 0,
        "localized text must not be empty",
      ),
  ]);
export const pluginThemeLabelSchema = text(80);
export const pluginThemeDescriptionSchema = text(240);
export const pluginThemeSpecSchema = z
  .strictObject({
    specVersion: z
      .number()
      .int()
      .min(1)
      .max(CURRENT_UI_SPEC_VERSION)
      .optional(),
    id: z.string().regex(PLUGIN_VIEW_ID_PATTERN),
    label: pluginThemeLabelSchema,
    description: pluginThemeDescriptionSchema.optional(),
    tokens: pluginThemeTokensSchema.optional(),
    layout: pluginThemeLayoutSchema.optional(),
    css: pluginThemePathSchema
      .refine((value) => value.endsWith(".css"), "expected a CSS file")
      .optional(),
    assets: z.strictObject({ root: pluginThemePathSchema }).optional(),
  })
  .refine(
    (value) =>
      value.tokens !== undefined ||
      value.layout !== undefined ||
      value.css !== undefined,
    "a theme needs tokens, layout or CSS",
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <=
      MAX_PLUGIN_THEME_SPEC_BYTES,
    "theme descriptor exceeds 32 KiB",
  );
export type PluginThemeSpec = z.infer<typeof pluginThemeSpecSchema>;
export type PluginThemeTokens = z.infer<typeof pluginThemeTokensSchema>;

export const PLUGIN_THEME_BITMAP_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
} as const;
export const pluginThemeAssetFileSchema = z
  .strictObject({
    path: pluginThemePathSchema.refine((value) => !value.startsWith("./")),
    mime: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/avif",
    ]),
    size: z.number().int().min(1).max(MAX_PLUGIN_THEME_BITMAP_FILE_BYTES),
  })
  .refine(
    (file) =>
      PLUGIN_THEME_BITMAP_MIME[
        file.path
          .split(".")
          .at(-1)
          ?.toLowerCase() as keyof typeof PLUGIN_THEME_BITMAP_MIME
      ] === file.mime,
    "bitmap extension must match its MIME",
  );
export const pluginThemeAssetsSchema = z
  .strictObject({
    digest: z.string().regex(/^[a-f0-9]{32}$/),
    files: z
      .array(pluginThemeAssetFileSchema)
      .min(1)
      .max(MAX_PLUGIN_THEME_BITMAP_FILES),
  })
  .refine(
    ({ files }) =>
      new Set(files.map((file) => file.path)).size === files.length &&
      files.reduce((sum, file) => sum + file.size, 0) <=
        MAX_PLUGIN_THEME_BITMAP_BYTES,
    "asset paths must be unique and total at most 8 MiB",
  );
export type PluginThemeAssets = z.infer<typeof pluginThemeAssetsSchema>;
