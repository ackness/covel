import { useCallback, useEffect, useState } from "react";
import i18n from "@/i18n";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  setStoredLocale,
  type SupportedLocale,
} from "@/i18n/locale-detector";

export type { SupportedLocale } from "@/i18n/locale-detector";
export { getStoredLocale, resolveInitialLocale } from "@/i18n/locale-detector";

function applyLocale(locale: SupportedLocale): void {
  void i18n.changeLanguage(locale);
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export function useLocalePreference(): {
  locale: SupportedLocale;
  setLocale: (next: SupportedLocale) => void;
} {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => {
    const current = i18n.language;
    return isSupportedLocale(current) ? current : DEFAULT_LOCALE;
  });

  useEffect(() => {
    const handler = (lng: string) => {
      if (isSupportedLocale(lng)) setLocaleState(lng);
    };
    i18n.on("languageChanged", handler);
    return () => {
      i18n.off("languageChanged", handler);
    };
  }, []);

  const setLocale = useCallback((next: SupportedLocale) => {
    setStoredLocale(next);
    applyLocale(next);
  }, []);

  return { locale, setLocale };
}
