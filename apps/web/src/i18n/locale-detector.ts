import {
  canonicalizeLocale,
  DEFAULT_FALLBACK_LOCALE,
  DEFAULT_LOCALE,
  localeLanguage,
} from "@covel/shared";
import { localeRegistry, type SupportedLocale } from "./catalog-registry.js";

export type { SupportedLocale } from "./catalog-registry.js";
export { DEFAULT_LOCALE };

/**
 * Locale constants and type guards. Storage moved to the unified
 * SettingsStore (`ui.locale`) — this module no longer reads or writes
 * localStorage directly.
 */
function detectFromNavigator(): SupportedLocale | null {
  if (typeof navigator === "undefined") return null;
  const candidate = navigator.language;
  const matched = localeRegistry.match(candidate);
  if (matched) return matched.code;

  // An unsupported script of the default language must not silently collapse
  // to that default (for example Traditional Chinese -> Simplified Chinese).
  const canonical = canonicalizeLocale(candidate);
  if (
    canonical &&
    localeLanguage(canonical) === localeLanguage(DEFAULT_LOCALE)
  ) {
    return DEFAULT_FALLBACK_LOCALE;
  }
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
