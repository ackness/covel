import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import enUS from "./locales/en-US.json";
import { DEFAULT_LOCALE, resolveInitialLocale } from "./locale-detector";

const resources = {
  "zh-CN": { translation: zhCN },
  "en-US": { translation: enUS },
};

const initialLocale = resolveInitialLocale();

i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: ["zh-CN", "en-US"],
  interpolation: {
    escapeValue: false,
  },
});

if (typeof document !== "undefined") {
  document.documentElement.lang = initialLocale;
}

export default i18n;
