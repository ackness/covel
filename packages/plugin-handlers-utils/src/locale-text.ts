import { instructionLocaleFor } from "./instruction-locale.js";

/**
 * Pick the instruction a session reads: the Simplified Chinese string when
 * `instructionLocaleFor(locale)` is `zh`, otherwise the English one. Use it
 * only for text the model reads; `COVEL_INSTRUCTION_LOCALE` applies to it as
 * it does to prompt bodies.
 *
 * Text the player sees has more than two languages: a plugin that ships
 * `locales/` files uses `translate` and `labelText`, which take the English
 * text and read every other language from those files.
 *
 * @param locale - Session locale, e.g. `"zh-CN"`, `"en"`, or `undefined`.
 * @param zh - Simplified Chinese instruction.
 * @param en - English instruction.
 */
export function pickLocaleText(
  locale: string | undefined,
  zh: string,
  en: string,
): string {
  return instructionLocaleFor(locale) === "zh" ? zh : en;
}
