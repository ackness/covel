import type { I18nText } from "@covel/shared";

export type ThemeScheme = "light" | "dark";
export type ThemeSource = "builtin" | "custom";

export interface ThemeManifest {
  id: string;
  label: I18nText;
  source: ThemeSource;
  schemes: readonly ThemeScheme[];
  description?: I18nText;
}

export interface ThemeDefinition extends ThemeManifest {
  cssText: string;
}

export interface StoredCustomTheme {
  id: string;
  label: I18nText;
  cssText: string;
  schemes: readonly ThemeScheme[];
  description?: I18nText;
  importedAt: string;
  fileName?: string;
}

export interface ImportedThemePayload {
  theme: ThemeDefinition;
  fileName: string;
}
