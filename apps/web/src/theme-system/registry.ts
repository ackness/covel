import { z } from "zod";
import type { I18nText, SettingOption, SettingsStoreApi } from "@covel/shared";
import { getBuiltinThemes } from "./builtins.js";
import { applyAppearance, DEFAULT_APPEARANCE } from "@/lib/appearance.js";
import { syncThemeStyles } from "./runtime.js";
import {
  CUSTOM_THEMES_KEY,
  THEME_MANAGER_WIDGET_KEY,
  loadStoredCustomThemes,
  saveStoredCustomThemes,
} from "./storage.js";
import type {
  StoredCustomTheme,
  ThemeDefinition,
  ThemeManifest,
} from "./types.js";

const builtinThemes = getBuiltinThemes();
let themeRegistry = new Map<string, ThemeDefinition>();
const BUILTIN_THEME_ORDER = ["paper", "modern", "abyss"];

function toThemeOption(theme: ThemeManifest): SettingOption {
  return {
    value: theme.id,
    label: theme.label,
  };
}

function sortThemes(themes: ThemeDefinition[]): ThemeDefinition[] {
  return [...themes].sort((a, b) => {
    if (a.source !== b.source) return a.source === "builtin" ? -1 : 1;
    if (a.source === "builtin" && b.source === "builtin") {
      return (
        BUILTIN_THEME_ORDER.indexOf(a.id) - BUILTIN_THEME_ORDER.indexOf(b.id)
      );
    }
    return labelToString(a.label).localeCompare(labelToString(b.label));
  });
}

function labelToString(label: I18nText): string {
  if (typeof label === "string") return label;
  return label["en-US"] ?? label["zh-CN"] ?? Object.values(label)[0] ?? "";
}

function buildRegistry(
  themes: ThemeDefinition[],
): Map<string, ThemeDefinition> {
  return new Map(themes.map((theme) => [theme.id, theme]));
}

function registerAppearanceEntry(store: SettingsStoreApi): void {
  const options = getRegisteredThemes().map((theme) => toThemeOption(theme));

  store.register({
    key: "ui.appearance",
    schema: z.string().min(1),
    default: DEFAULT_APPEARANCE,
    group: "general",
    widget: "select",
    label: { "zh-CN": "外观", "en-US": "Appearance" },
    description: {
      "zh-CN": "选择当前界面风格。导入的自定义主题会自动出现在这里。",
      "en-US":
        "Choose the active interface style. Imported custom themes appear here automatically.",
    },
    options,
  });
}

function registerThemeManagerEntry(store: SettingsStoreApi): void {
  store.register({
    key: THEME_MANAGER_WIDGET_KEY,
    schema: z.number().int(),
    default: 1,
    group: "general",
    widget: "custom",
    label: { "zh-CN": "主题库", "en-US": "Theme Library" },
    description: {
      "zh-CN": "导入、删除和复用自定义主题包。",
      "en-US": "Import, remove, and reuse custom theme packages.",
    },
  });
}

function toStoredTheme(
  theme: ThemeDefinition,
  fileName?: string,
): StoredCustomTheme {
  return {
    id: theme.id,
    label: theme.label,
    cssText: theme.cssText,
    schemes: theme.schemes,
    description: theme.description,
    importedAt: new Date().toISOString(),
    fileName,
  };
}

export function getRegisteredThemes(): ThemeDefinition[] {
  return sortThemes([...themeRegistry.values()]);
}

export function getThemeDefinition(id: string): ThemeDefinition | null {
  return themeRegistry.get(id) ?? null;
}

export function isRegisteredTheme(id: unknown): id is string {
  return typeof id === "string" && themeRegistry.has(id);
}

export function primeThemeRegistry(store: SettingsStoreApi): ThemeDefinition[] {
  themeRegistry = buildRegistry(sortThemes([...builtinThemes]));
  registerAppearanceEntry(store);
  registerThemeManagerEntry(store);
  return getRegisteredThemes();
}

export function syncThemeRegistry(store: SettingsStoreApi): ThemeDefinition[] {
  const customThemes = loadStoredCustomThemes(store).map<ThemeDefinition>(
    (theme) => ({
      ...theme,
      source: "custom",
    }),
  );
  const nextThemes = sortThemes([...builtinThemes, ...customThemes]);

  themeRegistry = buildRegistry(nextThemes);
  registerAppearanceEntry(store);
  registerThemeManagerEntry(store);
  syncThemeStyles(nextThemes);

  const selected = store.get<string>("ui.appearance");
  const resolved = themeRegistry.has(selected) ? selected : DEFAULT_APPEARANCE;

  if (selected !== resolved) {
    void store.set("ui.appearance", resolved);
  } else {
    applyAppearance(resolved);
  }

  return nextThemes;
}

export async function saveCustomTheme(
  store: SettingsStoreApi,
  theme: ThemeDefinition,
  fileName?: string,
): Promise<void> {
  const nextStoredThemes = loadStoredCustomThemes(store)
    .filter((entry) => entry.id !== theme.id)
    .concat(toStoredTheme(theme, fileName));

  await saveStoredCustomThemes(store, nextStoredThemes);
  syncThemeRegistry(store);
}

export async function deleteCustomTheme(
  store: SettingsStoreApi,
  themeId: string,
): Promise<void> {
  const nextStoredThemes = loadStoredCustomThemes(store).filter(
    (entry) => entry.id !== themeId,
  );
  await saveStoredCustomThemes(store, nextStoredThemes);
  syncThemeRegistry(store);
}
