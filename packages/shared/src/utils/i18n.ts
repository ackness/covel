import type { I18nText } from "../types/world.js";

/** Return a normalized primary language subtag (`en-US` / `en_US` → `en`). */
export function localeLanguage(locale: string | undefined): string | undefined {
  const language = locale
    ?.trim()
    .replaceAll("_", "-")
    .split("-")[0]
    ?.toLowerCase();
  return language || undefined;
}

function normalizedLocale(locale: string): string {
  return locale.trim().replaceAll("_", "-").toLowerCase();
}

function localeEntry(
  text: Record<string, string>,
  locale: string,
): string | undefined {
  const normalized = normalizedLocale(locale);
  return Object.entries(text).find(
    ([key, value]) =>
      normalizedLocale(key) === normalized && typeof value === "string",
  )?.[1];
}

/**
 * Resolve an {@link I18nText} value to a plain string for a given locale.
 *
 * Resolution order for locale-keyed records:
 *   1. exact locale key (e.g. `zh-CN`)
 *   2. language-only key, then another variant of the same language
 *   3. English (`en-US`, `en`, then another English variant)
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

  const languageOnly = localeLanguage(locale);
  if (languageOnly) {
    const languageEntry = localeEntry(text, languageOnly);
    if (languageEntry !== undefined) return languageEntry;
    for (const [key, value] of Object.entries(text)) {
      if (localeLanguage(key) === languageOnly && typeof value === "string") {
        return value;
      }
    }
  }

  for (const englishLocale of ["en-US", "en"] as const) {
    const english = localeEntry(text, englishLocale);
    if (english !== undefined) return english;
  }
  for (const [key, value] of Object.entries(text)) {
    if (localeLanguage(key) === "en" && typeof value === "string") {
      return value;
    }
  }

  const first = Object.values(text).find((v) => typeof v === "string");
  return first;
}

/** Matches a locale code key like `zh`, `en`, `zh-CN`, `en_US`. */
const LOCALE_KEY_RE = /^[a-z]{2}(?:[-_][a-z]{2})?$/i;

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
    entries.every(
      ([key, item]) => LOCALE_KEY_RE.test(key) && typeof item === "string",
    )
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
