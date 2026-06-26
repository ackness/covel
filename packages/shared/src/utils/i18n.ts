import type { I18nText } from "../types/world.js";

/**
 * Resolve an {@link I18nText} value to a plain string for a given locale.
 *
 * Resolution order for locale-keyed records:
 *   1. exact locale key (e.g. `zh-CN`)
 *   2. language-only match (e.g. `zh` matches `zh-CN`)
 *   3. first available value
 *
 * Returns `undefined` when the input is `undefined` (so callers can apply
 * their own fallback). A bare string is returned as-is.
 */
export function resolveI18nText(
  text: I18nText | undefined,
  locale?: string,
): string | undefined {
  if (text === undefined) return undefined;
  if (typeof text === "string") return text;

  if (locale && typeof text[locale] === "string") return text[locale];

  const languageOnly = locale?.split("-")[0];
  if (languageOnly) {
    for (const [key, value] of Object.entries(text)) {
      if (key.split("-")[0] === languageOnly && typeof value === "string") {
        return value;
      }
    }
  }

  const first = Object.values(text).find((v) => typeof v === "string");
  return first;
}
