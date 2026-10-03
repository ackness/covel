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

function toThemeDefinition(
  manifest: ThemeManifest,
  cssText: string,
): ThemeDefinition {
  return {
    ...manifest,
    source: "builtin",
    cssText,
  };
}

export function getBuiltinThemes(): ThemeDefinition[] {
  return [
    toThemeDefinition(panelManifest as ThemeManifest, panelCss),
    toThemeDefinition(bookManifest as ThemeManifest, bookCss),
    toThemeDefinition(stageManifest as ThemeManifest, stageCss),
    toThemeDefinition(paperManifest as ThemeManifest, paperCss),
    toThemeDefinition(modernManifest as ThemeManifest, modernCss),
    toThemeDefinition(abyssManifest as ThemeManifest, abyssCss),
    toThemeDefinition(auroraManifest as ThemeManifest, auroraCss),
  ];
}
