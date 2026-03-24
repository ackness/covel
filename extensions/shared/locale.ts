import { type SupportedLocale, normalizeLocale } from "../../modules/contracts/src/locale.js";

export function getLocale(input: unknown): SupportedLocale {
  return normalizeLocale(input);
}

export function pickLocalizedText(
  locale: unknown,
  input: {
    "zh-CN": string;
    en: string;
  }
): string {
  return getLocale(locale) === "en" ? input.en : input["zh-CN"];
}
