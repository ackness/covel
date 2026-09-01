import type { I18nText } from "../types/world.js";
import {
  canonicalizeLocale,
  localeLanguage,
  localeLookupCandidates,
  localeRegistry,
  localesShareLanguageAndScript,
  normalizeLocale,
} from "./locale-registry.js";

function localeEntry(
  text: Record<string, string>,
  locale: string,
): string | undefined {
  const normalized = normalizeLocale(locale);
  return Object.entries(text).find(
    ([key, value]) =>
      normalizeLocale(key) === normalized && typeof value === "string",
  )?.[1];
}

/**
 * Resolve an {@link I18nText} value to a plain string for a given locale.
 *
 * Resolution order for locale-keyed records:
 *   1. exact locale key (e.g. `zh-CN`)
 *   2. compatible language-only key, then another same-language/script variant
 *   3. fallbacks declared by the locale registry (English by default)
 *   4. first available value
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

  if (!locale?.trim()) {
    return Object.values(text).find((value) => typeof value === "string");
  }

  const exact = localeEntry(text, locale);
  if (exact !== undefined) return exact;

  for (const candidate of localeLookupCandidates(locale).slice(1)) {
    const candidateEntry = localeEntry(text, candidate);
    if (candidateEntry !== undefined) return candidateEntry;
  }
  for (const [key, value] of Object.entries(text)) {
    if (
      localesShareLanguageAndScript(locale, key) &&
      typeof value === "string"
    ) {
      return value;
    }
  }

  for (const fallbackLocale of localeRegistry.fallbackLocalesFor(locale)) {
    for (const candidate of localeLookupCandidates(fallbackLocale)) {
      const fallbackEntry = localeEntry(text, candidate);
      if (fallbackEntry !== undefined) return fallbackEntry;
    }
    for (const [key, value] of Object.entries(text)) {
      if (
        localesShareLanguageAndScript(fallbackLocale, key) &&
        typeof value === "string"
      ) {
        return value;
      }
    }
  }

  const first = Object.values(text).find((v) => typeof v === "string");
  return first;
}

const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], {
  type: "language",
  fallback: "none",
});

function isLocaleKey(key: string): boolean {
  const canonical = canonicalizeLocale(key);
  return (
    canonical !== undefined &&
    LANGUAGE_NAMES.of(localeLanguage(canonical) ?? canonical) !== undefined
  );
}

/**
 * True for a plain object whose every key is a locale code and every value is
 * a string — i.e. an inline {@link I18nText} record like `{ "zh-CN": "…", en: "…" }`.
 * A structured object (e.g. `{ name, description, type }`) is not a locale map.
 */
function isLocaleMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(([key, item]) => isLocaleKey(key) && typeof item === "string")
  );
}

/**
 * Deep-resolve every inline I18nText record inside an arbitrary value to a
 * plain string for `locale`, leaving all other data unchanged. Returns a new
 * value (never mutates the input).
 *
 * Used to localize world dimensions before they're injected into a prompt so
 * the narrator sees one language instead of a raw `{ zh, en }` blob, and by the
 * `world-dimension-get` tool to localize a queried dimension.
 */
export function resolveI18nDeep(value: unknown, locale?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveI18nDeep(item, locale));
  }
  if (isLocaleMap(value)) {
    return resolveI18nText(value, locale) ?? "";
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = resolveI18nDeep(item, locale);
    }
    return out;
  }
  return value;
}
