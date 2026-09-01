import type { I18nText } from "../types/world.js";

/** Declarative metadata for a player-selectable application locale. */
export interface LocaleDefinition<Code extends string = string> {
  /** Canonical BCP 47 locale persisted in settings and sessions. */
  readonly code: Code;
  /** Localized language name used by settings and locale switchers. */
  readonly label: I18nText;
  /** Compact, language-neutral label for space-constrained switchers. */
  readonly shortLabel: string;
  /** Browser/system locale aliases that should resolve to this locale. */
  readonly aliases?: readonly string[];
  /** Ordered locale fallbacks used by I18nText resolution. */
  readonly fallbackLocales?: readonly string[];
}

type LocaleDefinitions = readonly [LocaleDefinition, ...LocaleDefinition[]];

type LocaleCodeOf<Definitions extends LocaleDefinitions> =
  Definitions[number]["code"];

/** Maximum locale-tag length accepted at persistence and file-path boundaries. */
export const MAX_LOCALE_CODE_LENGTH = 64;

/**
 * Filesystem-safe lexical envelope for locale tags. Semantic BCP 47
 * validation is delegated to `Intl.getCanonicalLocales` below.
 */
export const LOCALE_CODE_RE = /^[a-z0-9]{1,8}(?:-[a-z0-9]{1,8})*$/i;

/**
 * Canonicalize a safe BCP 47 locale (`ru_ru` -> `ru-RU`). Path-like and
 * syntactically invalid values return `undefined` rather than reaching a
 * locale-variant file lookup.
 */
export function canonicalizeLocale(
  locale: string | undefined,
): string | undefined {
  if (!locale?.trim()) return undefined;
  const candidate = locale.trim().replaceAll("_", "-");
  if (candidate.length > MAX_LOCALE_CODE_LENGTH) return undefined;
  if (!LOCALE_CODE_RE.test(candidate)) return undefined;
  try {
    return Intl.getCanonicalLocales(candidate)[0];
  } catch {
    return undefined;
  }
}

/** True when a value is a safe, canonicalizable BCP 47 locale string. */
export function isLocaleCode(value: unknown): value is string {
  return typeof value === "string" && canonicalizeLocale(value) !== undefined;
}

/** Normalize a locale for comparison without changing its semantic subtags. */
export function normalizeLocale(locale: string): string {
  return locale.trim().replaceAll("_", "-").toLowerCase();
}

/** Return a normalized primary language subtag (`en-US` / `en_US` -> `en`). */
export function localeLanguage(locale: string | undefined): string | undefined {
  const language = locale ? normalizeLocale(locale).split("-")[0] : undefined;
  return language || undefined;
}

function localeScript(locale: string | undefined): string | undefined {
  const canonical = canonicalizeLocale(locale);
  if (!canonical) return undefined;
  try {
    return new Intl.Locale(canonical).maximize().script;
  } catch {
    return undefined;
  }
}

/**
 * True when two canonicalizable locales use the same primary language and
 * likely script. Regions may differ, but script boundaries never collapse
 * (for example `zh-Hant` is incompatible with bare `zh`, which maximizes to
 * Hans, while `en-GB` remains compatible with bare `en`).
 */
export function localesShareLanguageAndScript(
  first: string | undefined,
  second: string | undefined,
): boolean {
  const firstLanguage = localeLanguage(first);
  const secondLanguage = localeLanguage(second);
  if (!firstLanguage || firstLanguage !== secondLanguage) return false;

  const firstScript = localeScript(first);
  const secondScript = localeScript(second);
  return firstScript !== undefined && firstScript === secondScript;
}

/**
 * Locale tags to try for a localized resource: exact canonical tag followed
 * by the primary-language short key only when its inferred script is
 * compatible. Invalid/path-like input yields no candidates.
 */
export function localeLookupCandidates(
  locale: string | undefined,
): readonly string[] {
  const canonical = canonicalizeLocale(locale);
  if (!canonical) return [];

  const language = localeLanguage(canonical);
  if (
    !language ||
    normalizeLocale(language) === normalizeLocale(canonical) ||
    !localesShareLanguageAndScript(canonical, language)
  ) {
    return [canonical];
  }
  return [canonical, language];
}

/** Human-readable name for a canonicalizable locale in its own language. */
export function localeDisplayName(locale: string): string {
  const canonical = canonicalizeLocale(locale);
  if (!canonical) return locale;
  try {
    return (
      new Intl.DisplayNames([canonical], { type: "language" }).of(canonical) ??
      canonical
    );
  } catch {
    return canonical;
  }
}

/**
 * Build an immutable locale registry from one declarative definition list.
 * Consumers derive types, validation, switcher options, detection and fallback
 * order from this object instead of maintaining their own locale unions.
 */
export function defineLocaleRegistry<
  const Definitions extends LocaleDefinitions,
>(
  definitions: Definitions,
  options: {
    readonly defaultLocale: LocaleCodeOf<Definitions>;
    readonly fallbackLocale: LocaleCodeOf<Definitions>;
  },
) {
  type Code = LocaleCodeOf<Definitions>;
  const byCode = new Map<string, Definitions[number]>();
  const byAlias = new Map<string, Definitions[number]>();
  const fallbackLocales = new Map<Definitions[number], readonly string[]>();

  for (const definition of definitions) {
    const canonicalCode = canonicalizeLocale(definition.code);
    if (!canonicalCode) {
      throw new Error(`Invalid locale code: ${definition.code}`);
    }
    if (canonicalCode !== definition.code) {
      throw new Error(
        `Locale code must be canonical: ${definition.code} -> ${canonicalCode}`,
      );
    }
    const normalizedCode = normalizeLocale(canonicalCode);
    if (byCode.has(normalizedCode)) {
      throw new Error(`Duplicate locale code: ${definition.code}`);
    }
    byCode.set(normalizedCode, definition);

    fallbackLocales.set(
      definition,
      (definition.fallbackLocales ?? []).map((fallback) => {
        const canonicalFallback = canonicalizeLocale(fallback);
        if (!canonicalFallback) {
          throw new Error(
            `Invalid fallback locale for ${definition.code}: ${fallback}`,
          );
        }
        return canonicalFallback;
      }),
    );
  }
  for (const definition of definitions) {
    for (const alias of definition.aliases ?? []) {
      const canonicalAlias = canonicalizeLocale(alias);
      if (!canonicalAlias) {
        throw new Error(`Invalid locale alias: ${alias}`);
      }
      const normalizedAlias = normalizeLocale(canonicalAlias);
      if (byAlias.has(normalizedAlias) || byCode.has(normalizedAlias)) {
        throw new Error(`Duplicate locale alias: ${alias}`);
      }
      byAlias.set(normalizedAlias, definition);
    }
  }

  const codes = definitions.map(
    (definition) => definition.code,
  ) as unknown as readonly [Code, ...Code[]];

  function get(code: string | undefined): Definitions[number] | undefined {
    const canonical = canonicalizeLocale(code);
    return canonical ? byCode.get(normalizeLocale(canonical)) : undefined;
  }

  function resolve(
    locale: string | undefined,
  ): Definitions[number] | undefined {
    const canonical = canonicalizeLocale(locale);
    if (!canonical) return undefined;
    const normalized = normalizeLocale(canonical);
    return byCode.get(normalized) ?? byAlias.get(normalized);
  }

  /**
   * Best-fit locale detection for browser/system preferences. Unlike
   * `resolve`, this may match a different region, but never crosses scripts
   * (for example `zh-TW`/Hant must not collapse to `zh-CN`/Hans).
   */
  function match(locale: string | undefined): Definitions[number] | undefined {
    const exact = resolve(locale);
    if (exact) return exact;

    const language = localeLanguage(locale);
    if (!language) return undefined;
    return definitions.find(
      (definition) =>
        localeLanguage(definition.code) === language &&
        localesShareLanguageAndScript(locale, definition.code),
    );
  }

  function has(value: unknown): value is Code {
    return typeof value === "string" && get(value) !== undefined;
  }

  function canonicalize(locale: string | undefined): Code | undefined {
    return resolve(locale)?.code as Code | undefined;
  }

  function fallbackLocalesFor(locale: string | undefined): readonly string[] {
    const definition = resolve(locale);
    const fallbacks = definition ? (fallbackLocales.get(definition) ?? []) : [];
    const withDefault = [
      ...fallbacks,
      ...(definition?.code === options.fallbackLocale
        ? []
        : [options.fallbackLocale]),
    ];
    const seen = new Set<string>();
    return withDefault.filter((fallback) => {
      const normalized = normalizeLocale(fallback);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  if (!get(options.defaultLocale) || !get(options.fallbackLocale)) {
    throw new Error("Locale registry defaults must reference registered codes");
  }

  return Object.freeze({
    definitions,
    codes,
    defaultLocale: options.defaultLocale,
    fallbackLocale: options.fallbackLocale,
    get,
    resolve,
    match,
    has,
    canonicalize,
    fallbackLocalesFor,
  });
}

/**
 * Application locales shipped by Covel. Adding a built-in locale starts here;
 * all framework consumers derive their supported codes and labels from this
 * registry. Locale-specific catalogs remain next to their owning UI/runtime.
 */
export const LOCALE_DEFINITIONS = [
  {
    code: "zh-CN",
    label: {
      "zh-CN": "简体中文",
      "en-US": "Chinese (Simplified)",
      "ru-RU": "Китайский (упрощённый)",
    },
    shortLabel: "中",
    aliases: ["zh", "zh-Hans"],
    fallbackLocales: ["en-US"],
  },
  {
    code: "en-US",
    label: {
      "zh-CN": "英语",
      "en-US": "English",
      "ru-RU": "Английский",
    },
    shortLabel: "EN",
    aliases: ["en"],
  },
  {
    code: "ru-RU",
    label: {
      "zh-CN": "俄语",
      "en-US": "Russian",
      "ru-RU": "Русский",
    },
    shortLabel: "RU",
    aliases: ["ru"],
    fallbackLocales: ["en-US"],
  },
] as const satisfies LocaleDefinitions;

export type SupportedLocale = (typeof LOCALE_DEFINITIONS)[number]["code"];

export const localeRegistry = defineLocaleRegistry(LOCALE_DEFINITIONS, {
  defaultLocale: "zh-CN",
  fallbackLocale: "en-US",
});

export const SUPPORTED_LOCALES = localeRegistry.codes;
export const DEFAULT_LOCALE = localeRegistry.defaultLocale;
export const DEFAULT_FALLBACK_LOCALE = localeRegistry.fallbackLocale;

/** True only for the registered default locale or one of its explicit aliases. */
export function isDefaultLocale(locale: string | undefined): boolean {
  return localeRegistry.resolve(locale)?.code === DEFAULT_LOCALE;
}
