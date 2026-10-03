import type { SettingsStoreApi } from "@covel/settings";
import { i18nTextSchema } from "@covel/shared";
import { parseThemeLayoutSpec } from "./layout.js";
import type { StoredCustomTheme } from "./types.js";

export const CUSTOM_THEMES_KEY = "ui.customThemes";
export const THEME_MANAGER_WIDGET_KEY = "ui.themeManager";

/**
 * `ui.customThemes` is not a registered setting, so `SettingsStore.import`
 * skips schema validation for it — a shared "settings backup" JSON can carry
 * arbitrary cssText straight past `parseImportedThemeFile`. Strip `@import` on
 * the way *in*, so one chokepoint covers file import, settings import, hand
 * edits and legacy rows alike. (Full scope enforcement runs at import time;
 * applying it here too would silently delete themes players already have.)
 */
/** Same shape as a theme id: the group may name the package it derives from. */
const THEME_GROUP_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;

function stripAtImports(cssText: string): string {
  return cssText.replace(/@import\b[^;]*;?/gi, "");
}

function normalizeStoredTheme(value: unknown): StoredCustomTheme | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.cssText !== "string")
    return null;
  const label = i18nTextSchema.safeParse(raw.label);
  if (!label.success) return null;
  const description = i18nTextSchema.safeParse(raw.description);
  const groupLabel = i18nTextSchema.safeParse(raw.groupLabel);

  return {
    id: raw.id,
    label: label.data,
    cssText: stripAtImports(raw.cssText),
    schemes:
      Array.isArray(raw.schemes) && raw.schemes.length > 0
        ? raw.schemes.filter(
            (scheme): scheme is "light" | "dark" =>
              scheme === "light" || scheme === "dark",
          )
        : ["light", "dark"],
    description: description.success ? description.data : undefined,
    layout: parseThemeLayoutSpec(raw.layout),
    group:
      typeof raw.group === "string" && THEME_GROUP_PATTERN.test(raw.group)
        ? raw.group
        : undefined,
    groupLabel: groupLabel.success ? groupLabel.data : undefined,
    importedAt:
      typeof raw.importedAt === "string" && raw.importedAt.length > 0
        ? raw.importedAt
        : new Date().toISOString(),
    fileName: typeof raw.fileName === "string" ? raw.fileName : undefined,
  };
}

export function loadStoredCustomThemes(
  store: SettingsStoreApi,
): StoredCustomTheme[] {
  const raw = store.get<unknown>(CUSTOM_THEMES_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => normalizeStoredTheme(value))
    .filter((value): value is StoredCustomTheme => value !== null);
}

export async function saveStoredCustomThemes(
  store: SettingsStoreApi,
  themes: StoredCustomTheme[],
): Promise<void> {
  await store.set(CUSTOM_THEMES_KEY, themes);
}
