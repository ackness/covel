import i18n, { type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";
import {
  localeRegistry,
  supportedLocales,
  webLocaleCatalog,
} from "./catalog-registry.js";
import { resolveInitialLocale } from "./locale-detector";

const initialLocale = resolveInitialLocale();

const catalogBackend: BackendModule = {
  type: "backend",
  init() {},
  read(language, namespace, callback) {
    if (namespace !== "translation") {
      callback(new Error(`Unsupported i18n namespace: ${namespace}`), false);
      return;
    }
    void webLocaleCatalog.loadCatalog(language).then(
      (catalog) => callback(null, catalog),
      (error: unknown) =>
        callback(error instanceof Error ? error : String(error), false),
    );
  },
};

export const i18nReady = i18n
  .use(catalogBackend)
  .use(initReactI18next)
  .init({
    lng: initialLocale,
    fallbackLng: localeRegistry.fallbackLocale,
    supportedLngs: supportedLocales,
    load: "currentOnly",
    ns: ["translation"],
    defaultNS: "translation",
    interpolation: {
      escapeValue: false,
    },
  });

if (typeof document !== "undefined") {
  document.documentElement.lang = initialLocale;
}

export {
  localeDefinitions,
  localeRegistry,
  supportedLocales,
} from "./catalog-registry.js";
export type { SupportedLocale } from "./catalog-registry.js";

export default i18n;
