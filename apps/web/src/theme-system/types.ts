import type { I18nText, ResolvedPluginTheme } from "@covel/shared";
import type { ThemeLayoutSpec } from "./layout.js";

export type ThemeScheme = "light" | "dark";
export type ThemeSource = "builtin" | "custom" | "plugin";

/** Session sources never enter the global appearance library. */
export interface PluginThemeSource {
  readonly source: "plugin";
  readonly pluginId: string;
  readonly themeId: string;
  readonly contentHash: string;
  readonly theme: ResolvedPluginTheme;
  readonly owner: string;
}

export interface ThemeManifest {
  id: string;
  label: I18nText;
  source: ThemeSource;
  schemes: readonly ThemeScheme[];
  description?: I18nText;
  /** Structural preset; omitted means the classic layout. */
  layout?: ThemeLayoutSpec;
  /**
   * Packages sharing a group are one style in the picker, offered as its
   * colourways. Omitted means the package is a style of its own.
   */
  group?: string;
  /** Display name of the group; the first declaring package wins. */
  groupLabel?: I18nText;
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
  layout?: ThemeLayoutSpec;
  group?: string;
  groupLabel?: I18nText;
  importedAt: string;
  fileName?: string;
}

export interface ImportedThemePayload {
  theme: ThemeDefinition;
  fileName: string;
}
