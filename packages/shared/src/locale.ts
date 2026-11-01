// Keep locale consumers independent of the shared domain/schema barrel.
export {
  DEFAULT_FALLBACK_LOCALE,
  DEFAULT_LOCALE,
  LOCALE_CODE_RE,
  LOCALE_DEFINITIONS,
  MAX_LOCALE_CODE_LENGTH,
  SUPPORTED_LOCALES,
  canonicalizeLocale,
  defineLocaleRegistry,
  isDefaultLocale,
  isLocaleCode,
  localeDisplayName,
  localeLanguage,
  localeLookupCandidates,
  localeRegistry,
  localesShareLanguageAndScript,
  normalizeLocale,
} from "@covel/plugin-handlers-utils";
