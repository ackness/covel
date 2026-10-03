import {
  canonicalizeLocale,
  localeLanguage,
  localeLookupCandidates,
  localesShareLanguageAndScript,
} from "./locale-registry.js";

/**
 * Languages a framework or plugin prompt may be written in. English is the
 * base: the canonical `PLUGIN.md` / `RUNTIME.md` body is English and every
 * plugin must supply it. Simplified Chinese is an optional variant in
 * `*.zh.md`.
 *
 * Other locales get no instruction set of their own. They read the English
 * base, and the framework's output-language directive makes the model answer
 * in the session's content locale. That includes Traditional Chinese:
 * Simplified instructions pull the output toward Simplified characters, so
 * scripts never substitute for each other.
 */
export const INSTRUCTION_LOCALES = ["en", "zh"] as const;
export type InstructionLocale = (typeof INSTRUCTION_LOCALES)[number];

function isInstructionLocale(value: unknown): value is InstructionLocale {
  return value === "en" || value === "zh";
}

function isSimplifiedChinese(locale: string | undefined): boolean {
  return localesShareLanguageAndScript(canonicalizeLocale(locale), "zh");
}

/**
 * `COVEL_INSTRUCTION_LOCALE` forces one instruction language for every
 * session. It exists for operators and for A/B measurements.
 */
export function instructionLocaleOverride(
  env: Readonly<Record<string, string | undefined>> = typeof process ===
  "undefined"
    ? {}
    : process.env,
): InstructionLocale | undefined {
  const value = env.COVEL_INSTRUCTION_LOCALE?.trim().toLowerCase();
  return isInstructionLocale(value) ? value : undefined;
}

/** The instruction language a session with this content locale reads. */
export function instructionLocaleFor(
  locale: string | undefined,
  override: InstructionLocale | undefined = instructionLocaleOverride(),
): InstructionLocale {
  if (override) return override;
  return isSimplifiedChinese(locale) ? "zh" : "en";
}

/**
 * Locale tags of the variant files to try before the canonical English file,
 * most specific first. Empty when the canonical file applies.
 */
export function instructionVariantCandidates(
  locale: string | undefined,
  override: InstructionLocale | undefined = instructionLocaleOverride(),
): readonly string[] {
  if (instructionLocaleFor(locale, override) !== "zh") return [];
  const own = isSimplifiedChinese(locale) ? localeLookupCandidates(locale) : [];
  return [...new Set([...own, "zh"])];
}

/**
 * How far the framework supports a language.
 *
 * `native`: the instructions exist in this language (English and Simplified
 * Chinese). `extended`: labels and world editions only. A session in an
 * extended language gives the model English instructions and asks for output
 * in that language, so the quality depends on the model.
 */
export type LocaleTier = "native" | "extended";

export function localeTier(locale: string | undefined): LocaleTier {
  return localeLanguage(locale) === "en" || isSimplifiedChinese(locale)
    ? "native"
    : "extended";
}

/** Whether a variant file's locale tag names an instruction-language variant. */
export function isInstructionVariantLocale(locale: string): boolean {
  return isSimplifiedChinese(locale);
}
