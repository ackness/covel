import type { SettingsStoreApi } from "@covel/shared";
import type { StoredCustomTheme } from "./types.js";

export const CUSTOM_THEMES_KEY = "ui.customThemes";
export const THEME_MANAGER_WIDGET_KEY = "ui.themeManager";

function normalizeStoredTheme(value: unknown): StoredCustomTheme | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<StoredCustomTheme>;
  if (typeof raw.id !== "string" || typeof raw.cssText !== "string") return null;
  if (typeof raw.label !== "string" && typeof raw.label !== "object") return null;

  return {
    id: raw.id,
    label: raw.label,
    cssText: raw.cssText,
    schemes:
      Array.isArray(raw.schemes) && raw.schemes.length > 0
        ? raw.schemes.filter((scheme): scheme is "light" | "dark" =>
          scheme === "light" || scheme === "dark",
        )
        : ["light", "dark"],
    description: raw.description,
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
