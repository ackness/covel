/**
 * Pick the Simplified Chinese string only for the registered default locale
 * or one of its explicit aliases. Other scripts and unregistered locales use
 * the English framework fallback.
 *
 * Two languages, both in the code. A plugin that ships `locales/` files uses
 * `translate` and `labelText`, which take the English text and read every
 * other language from those files.
 *
 * @param locale - Session locale, e.g. `"zh-CN"`, `"en"`, or `undefined`.
 * @param zh - Chinese string.
 * @param en - English (default) string.
 */
export function pickLocaleText(
  locale: string | undefined,
  zh: string,
  en: string,
): string {
  const normalized = locale?.trim().replaceAll("_", "-").toLowerCase();
  return normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-hans"
    ? zh
    : en;
}
