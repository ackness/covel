import { z } from "zod";
import {
  MAX_PLUGIN_THEMES,
  pluginThemeAssetsSchema,
  pluginThemeDescriptionSchema,
  pluginThemeLabelSchema,
  pluginThemeLayoutSchema,
  pluginThemeTokensSchema,
} from "./schemas/plugin-theme.js";
import { PLUGIN_VIEW_ID_PATTERN } from "./schemas/view-mode.js";
import { validateCompiledPluginThemeCss } from "./plugin-theme-css.js";

/** Public, compiled appearance metadata. No package paths, code or raw CSS. */
export const resolvedPluginThemeSchema = z
  .strictObject({
    pluginId: z.string().regex(/^[a-z][a-z0-9-]*$/),
    id: z.string().regex(PLUGIN_VIEW_ID_PATTERN),
    label: pluginThemeLabelSchema,
    description: pluginThemeDescriptionSchema.optional(),
    tokens: pluginThemeTokensSchema.optional(),
    layout: pluginThemeLayoutSchema.optional(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    cssText: z.string().optional(),
    assets: pluginThemeAssetsSchema.optional(),
  })
  .superRefine((theme, context) => {
    if (!theme.tokens && !theme.layout && !theme.cssText)
      context.addIssue({
        code: "custom",
        message: "theme has no appearance contribution",
      });
    if (theme.cssText !== undefined) {
      const checked = validateCompiledPluginThemeCss(theme.cssText, {
        pluginId: theme.pluginId,
        scope: theme.contentHash,
        assets: theme.assets,
      });
      if (!checked.success || checked.css !== theme.cssText)
        context.addIssue({
          code: "custom",
          path: ["cssText"],
          message: "invalid compiled theme CSS",
        });
    }
  });
export type ResolvedPluginTheme = z.infer<typeof resolvedPluginThemeSchema>;

/** The discovery group owner must also own every nested theme. */
export const resolvedPluginThemeEntrySchema = z
  .strictObject({
    pluginId: z.string().regex(/^[a-z][a-z0-9-]*$/),
    specs: z.array(resolvedPluginThemeSchema).max(MAX_PLUGIN_THEMES),
  })
  .refine(
    (entry) =>
      entry.specs.every((theme) => theme.pluginId === entry.pluginId) &&
      new Set(entry.specs.map((theme) => theme.id)).size === entry.specs.length,
    "theme group must contain unique local IDs belonging to its owner",
  );
export type ResolvedPluginThemeEntry = z.infer<
  typeof resolvedPluginThemeEntrySchema
>;
