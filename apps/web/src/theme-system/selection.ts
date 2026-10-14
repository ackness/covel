import type { SettingsStoreApi } from "@covel/settings";
import {
  DEFAULT_APPEARANCE,
  DEFAULT_COLOR_SCHEME,
  THEME_SCHEME_KEY,
} from "@/lib/appearance.js";
import { getBuiltinThemes } from "./builtins.js";
import { loadStoredCustomThemes } from "./storage.js";
import type { ThemeDefinition, ThemeScheme } from "./types.js";

/** Resolve display values without changing the player's stored preferences. */
export function resolveThemeSelection(
  themes: readonly ThemeDefinition[],
  id: string,
  preferred: unknown,
) {
  const theme =
    themes.find((entry) => entry.id === id) ??
    themes.find((entry) => entry.id === DEFAULT_APPEARANCE) ??
    themes[0];
  const requested =
    preferred === "light" || preferred === "dark"
      ? preferred
      : DEFAULT_COLOR_SCHEME;
  const scheme: ThemeScheme = theme?.schemes.includes(requested)
    ? requested
    : (theme?.schemes[0] ?? DEFAULT_COLOR_SCHEME);
  return {
    theme,
    id: theme?.id ?? DEFAULT_APPEARANCE,
    scheme,
    corrected: theme?.id !== id || scheme !== preferred,
  };
}

export function storedThemeSelection(store: SettingsStoreApi) {
  const builtins = getBuiltinThemes();
  const custom = loadStoredCustomThemes(store)
    .filter((theme) => !builtins.some((builtin) => builtin.id === theme.id))
    .map((theme) => ({ ...theme, source: "custom" as const }));
  return resolveThemeSelection(
    [...builtins, ...custom],
    store.get<string>("ui.appearance"),
    store.get(THEME_SCHEME_KEY),
  );
}
