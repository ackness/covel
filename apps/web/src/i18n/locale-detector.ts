export type SupportedLocale = "zh-CN" | "en-US";

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ["zh-CN", "en-US"];
export const LOCALE_STORAGE_KEY = "covel:locale";
export const DEFAULT_LOCALE: SupportedLocale = "zh-CN";

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

export function getStoredLocale(): SupportedLocale | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isSupportedLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function setStoredLocale(locale: SupportedLocale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // storage unavailable (private mode / quota); silently skip
  }
}

function detectFromNavigator(): SupportedLocale | null {
  if (typeof navigator === "undefined") return null;
  const lang = navigator.language?.toLowerCase() ?? "";
  if (lang.startsWith("zh")) return "zh-CN";
  if (lang.startsWith("en")) return "en-US";
  return null;
}

export function resolveInitialLocale(): SupportedLocale {
  return getStoredLocale() ?? detectFromNavigator() ?? DEFAULT_LOCALE;
}
