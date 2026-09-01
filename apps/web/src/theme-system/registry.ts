import { z } from "zod";
import { resolveI18nText, type I18nText } from "@covel/shared";
import type { SettingOption, SettingsStoreApi } from "@covel/settings";
import { getBuiltinThemes } from "./builtins.js";
import {
  applyAppearance,
  applyColorScheme,
  DEFAULT_APPEARANCE,
  DEFAULT_COLOR_SCHEME,
  THEME_SCHEME_KEY,
} from "@/lib/appearance.js";
import { applyTokenOverrides } from "./overrides.js";
import { syncThemeStyles } from "./runtime.js";
import {
  CUSTOM_THEMES_KEY,
  THEME_MANAGER_WIDGET_KEY,
  loadStoredCustomThemes,
  saveStoredCustomThemes,
} from "./storage.js";
import type {
  StoredCustomTheme,
  ThemeScheme,
  ThemeDefinition,
  ThemeManifest,
} from "./types.js";

const builtinThemes = getBuiltinThemes();
let themeRegistry = new Map<string, ThemeDefinition>();
const BUILTIN_THEME_ORDER = ["paper", "modern", "abyss", "aurora"];
export { THEME_SCHEME_KEY };

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
  return resolveI18nText(label, "en-US") ?? "";
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
    label: "Appearance",
    description:
      "Choose the active interface style. Imported custom themes appear here automatically.",
    options,
  });
}

function registerSchemeEntry(store: SettingsStoreApi): void {
  store.register({
    key: THEME_SCHEME_KEY,
    schema: z.enum(["light", "dark"]),
    default: DEFAULT_COLOR_SCHEME,
    group: "general",
    widget: "select",
    label: "Color scheme",
    description:
      "Choose light or dark. Single-scheme themes automatically lock to the supported mode.",
    options: [
      {
        value: "light",
        label: "Light",
      },
      {
        value: "dark",
        label: "Dark",
      },
    ],
  });
}

function registerThemeManagerEntry(store: SettingsStoreApi): void {
  store.register({
    key: THEME_MANAGER_WIDGET_KEY,
    schema: z.number().int(),
    default: 1,
    group: "general",
    widget: "custom",
    label: "Theme Library",
    description: "Import, remove, and reuse custom theme packages.",
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

function normalizeScheme(value: unknown): ThemeScheme {
  return value === "light" || value === "dark" ? value : DEFAULT_COLOR_SCHEME;
}

function resolveThemeScheme(
  theme: ThemeDefinition | null,
  preferred: unknown,
): ThemeScheme {
  const selected = normalizeScheme(preferred);
  const schemes = theme?.schemes ?? [DEFAULT_COLOR_SCHEME];
  if (schemes.includes(selected)) return selected;
  return schemes[0] ?? DEFAULT_COLOR_SCHEME;
}

function applyThemeSelection(store: SettingsStoreApi): void {
  const selected = store.get<string>("ui.appearance");
  const resolvedTheme = themeRegistry.has(selected)
    ? selected
    : DEFAULT_APPEARANCE;
  const theme =
    themeRegistry.get(resolvedTheme) ??
    themeRegistry.values().next().value ??
    null;
  const selectedScheme = store.get<ThemeScheme>(THEME_SCHEME_KEY);
  const resolvedScheme = resolveThemeScheme(theme, selectedScheme);

  if (selected !== resolvedTheme) {
    applyAppearance(resolvedTheme);
    void store.set("ui.appearance", resolvedTheme);
  } else {
    applyAppearance(resolvedTheme);
  }

  if (selectedScheme !== resolvedScheme) {
    applyColorScheme(resolvedScheme);
    void store.set(THEME_SCHEME_KEY, resolvedScheme);
  } else {
    applyColorScheme(resolvedScheme);
  }

  // Re-point the player's token overrides last: they layer on whatever theme
  // and scheme just resolved, and the colour half of them is scheme-specific.
  applyTokenOverrides(store);
}

export function getRegisteredThemes(): ThemeDefinition[] {
  return sortThemes([...themeRegistry.values()]);
}

export function getThemeDefinition(id: string): ThemeDefinition | null {
  return themeRegistry.get(id) ?? null;
}

export function primeThemeRegistry(store: SettingsStoreApi): ThemeDefinition[] {
  themeRegistry = buildRegistry(sortThemes([...builtinThemes]));
  registerAppearanceEntry(store);
  registerSchemeEntry(store);
  registerThemeManagerEntry(store);
  return getRegisteredThemes();
}

const BUILTIN_THEME_IDS = new Set(builtinThemes.map((theme) => theme.id));

export function syncThemeRegistry(store: SettingsStoreApi): ThemeDefinition[] {
  const customThemes = loadStoredCustomThemes(store)
    // A custom theme declaring a builtin id would silently replace that
    // builtin's styling everywhere (same `data-theme` value, same style
    // element id). Builtins always win.
    .filter((theme) => !BUILTIN_THEME_IDS.has(theme.id))
    .map<ThemeDefinition>((theme) => ({
      ...theme,
      source: "custom",
    }));
  const nextThemes = sortThemes([...builtinThemes, ...customThemes]);

  themeRegistry = buildRegistry(nextThemes);
  registerAppearanceEntry(store);
  registerSchemeEntry(store);
  registerThemeManagerEntry(store);
  // Mount builtins plus ONLY the selected custom theme. Mounting every
  // registered theme meant an imported theme the player never selected still
  // applied any rule that escaped its `data-theme` scope — and kept applying
  // it after a restart.
  const selectedId = store.get<string>("ui.appearance");
  syncThemeStyles(
    nextThemes.filter(
      (theme) => theme.source !== "custom" || theme.id === selectedId,
    ),
  );
  applyThemeSelection(store);

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
