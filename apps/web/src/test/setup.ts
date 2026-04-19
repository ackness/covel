// Vitest setup for apps/web unit tests.
//
// The i18n bootstrap (`src/i18n/index.ts`) resolves the initial locale from
// localStorage → navigator.language → default. jsdom reports navigator.language
// as "en-US", which would flip every I18nText-dependent snapshot test to
// English. Tests that need a specific locale should set it explicitly; we
// default to zh-CN so historical Chinese assertions keep working.
import i18n from "@/i18n";

if (typeof window !== "undefined") {
  try {
    window.localStorage.setItem("covel:locale", "zh-CN");
  } catch {
    // storage may be unavailable in some environments
  }
}

// Force i18n back to zh-CN in case i18n/index.ts already ran (which is likely,
// because vitest may load the module graph before setupFiles execute).
void i18n.changeLanguage("zh-CN");
