import { useCallback, useEffect } from "react";
import i18n from "@/i18n";
import { useSetting } from "@/settings/use-settings.js";
import type { SupportedLocale } from "@/i18n/locale-detector.js";

export type { SupportedLocale } from "@/i18n/locale-detector.js";
export { getStoredLocale, resolveInitialLocale } from "@/i18n/locale-detector.js";

/**
 * Read and write the current locale through the unified settings store.
 * Keeps i18next and `document.documentElement.lang` in sync automatically.
 */
export function useLocalePreference(): {
  locale: SupportedLocale;
  setLocale: (next: SupportedLocale) => void;
} {
  const [locale, setLocaleAsync] = useSetting<SupportedLocale>("ui.locale");

  useEffect(() => {
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const setLocale = useCallback(
    (next: SupportedLocale) => {
      void setLocaleAsync(next);
    },
    [setLocaleAsync],
  );

  return { locale, setLocale };
}
