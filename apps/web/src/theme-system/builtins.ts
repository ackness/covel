import type { ThemeDefinition, ThemeManifest } from "./types.js";
import modernManifest from "@/themes/builtins/modern/manifest.json";
import modernCss from "@/themes/builtins/modern/theme.css?raw";
import paperManifest from "@/themes/builtins/paper/manifest.json";
import paperCss from "@/themes/builtins/paper/theme.css?raw";
import abyssManifest from "@/themes/builtins/abyss/manifest.json";
import abyssCss from "@/themes/builtins/abyss/theme.css?raw";

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
    toThemeDefinition(paperManifest as ThemeManifest, paperCss),
    toThemeDefinition(modernManifest as ThemeManifest, modernCss),
    toThemeDefinition(abyssManifest as ThemeManifest, abyssCss),
  ];
}
