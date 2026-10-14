import i18n from "@/i18n";
import type { ThemeDefinition, ThemeManifest } from "./types.js";
import modernManifest from "@/themes/builtins/modern/manifest.json";
import modernCss from "@/themes/builtins/modern/theme.css?raw";
import paperManifest from "@/themes/builtins/paper/manifest.json";
import paperCss from "@/themes/builtins/paper/theme.css?raw";
import abyssManifest from "@/themes/builtins/abyss/manifest.json";
import abyssCss from "@/themes/builtins/abyss/theme.css?raw";
import auroraManifest from "@/themes/builtins/aurora/manifest.json";
import auroraCss from "@/themes/builtins/aurora/theme.css?raw";
import bookManifest from "@/themes/builtins/book/manifest.json";
import bookCss from "@/themes/builtins/book/theme.css?raw";
import stageManifest from "@/themes/builtins/stage/manifest.json";
import stageCss from "@/themes/builtins/stage/theme.css?raw";
import panelManifest from "@/themes/builtins/panel/manifest.json";
import panelCss from "@/themes/builtins/panel/theme.css?raw";

type BuiltinThemeManifest = Omit<
  ThemeManifest,
  "label" | "description" | "groupLabel"
>;

export function localizeBuiltinTheme(theme: ThemeDefinition): ThemeDefinition {
  if (theme.source !== "builtin") return theme;
  const prefix = `appearance.builtinThemes.${theme.id}`;
  return {
    ...theme,
    label: i18n.t(`${prefix}.label`),
    description: i18n.t(`${prefix}.description`),
    groupLabel: i18n.t(`${prefix}.groupLabel`),
  };
}

function toThemeDefinition(
  manifest: BuiltinThemeManifest,
  cssText: string,
): ThemeDefinition {
  return localizeBuiltinTheme({
    ...manifest,
    label: manifest.id,
    source: "builtin",
    cssText,
  });
}

export function getBuiltinThemes(): ThemeDefinition[] {
  return [
    toThemeDefinition(panelManifest as BuiltinThemeManifest, panelCss),
    toThemeDefinition(bookManifest as BuiltinThemeManifest, bookCss),
    toThemeDefinition(stageManifest as BuiltinThemeManifest, stageCss),
    toThemeDefinition(paperManifest as BuiltinThemeManifest, paperCss),
    toThemeDefinition(modernManifest as BuiltinThemeManifest, modernCss),
    toThemeDefinition(abyssManifest as BuiltinThemeManifest, abyssCss),
    toThemeDefinition(auroraManifest as BuiltinThemeManifest, auroraCss),
  ];
}

export const BUILTIN_THEME_IDS: ReadonlySet<string> = new Set(
  getBuiltinThemes().map((theme) => theme.id),
);
