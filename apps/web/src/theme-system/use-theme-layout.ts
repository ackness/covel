import { useMemo } from "react";
import { useSetting, useSettingsStore } from "@/settings/use-settings.js";
import type { ResolvedThemeLayout } from "./layout.js";
import { getThemeLayout } from "./registry.js";
import { CUSTOM_THEMES_KEY } from "./storage.js";

/** The active theme package's resolved layout, tracking theme switches. */
export function useThemeLayout(): ResolvedThemeLayout {
  const store = useSettingsStore();
  const [appearance] = useSetting<string>("ui.appearance");
  // Re-resolve when a custom package is imported, edited or removed.
  const [customThemes] = useSetting<unknown>(CUSTOM_THEMES_KEY);
  return useMemo(
    () => getThemeLayout(store, appearance),
    [store, appearance, customThemes],
  );
}
