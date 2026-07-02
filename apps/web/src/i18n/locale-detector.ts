/**
 * Locale constants and type guards. Storage moved to the unified
 * SettingsStore (`ui.locale`) — this module no longer reads or writes
 * localStorage directly.
 */
export type SupportedLocale = "zh-CN" | "en-US";

export const DEFAULT_LOCALE: SupportedLocale = "zh-CN";

function detectFromNavigator(): SupportedLocale | null {
  if (typeof navigator === "undefined") return null;
  const lang = navigator.language?.toLowerCase() ?? "";
  if (lang.startsWith("zh")) return "zh-CN";
  if (lang.startsWith("en")) return "en-US";
  return null;
}

/**
 * Best-effort guess used only before the SettingsStore has hydrated (e.g.
 * for SSR defaults or tests). Once `initSettings()` resolves, callers should
 * prefer `useSetting('ui.locale')`.
 */
export function resolveInitialLocale(): SupportedLocale {
  return detectFromNavigator() ?? DEFAULT_LOCALE;
}
