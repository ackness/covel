import type { WorldRecord } from "@/services/api.js";
import {
  canonicalizeLocale,
  DEFAULT_FALLBACK_LOCALE,
  localeLanguage,
  MAX_LOCALE_CODE_LENGTH,
  resolveI18nText,
} from "@covel/shared";
import { localeRegistry } from "@/i18n/catalog-registry.js";

export type WorldLanguage = string;

function worldLocaleCode(locale: string | undefined): string | null {
  if (!locale || locale.length > MAX_LOCALE_CODE_LENGTH) return null;
  return canonicalizeLocale(locale) ?? null;
}

function worldLanguageIdentity(locale: string | undefined): string | null {
  const code = worldLocaleCode(locale);
  if (!code) return null;
  try {
    const maximized = new Intl.Locale(code).maximize();
    return `${maximized.language}-${maximized.script ?? ""}`;
  } catch {
    return null;
  }
}

/** Normalize the primary language subtag used by Covel's locale switcher. */
export function worldLanguage(
  locale: string | undefined,
): WorldLanguage | null {
  const code = worldLocaleCode(locale);
  return code ? (localeLanguage(code) ?? null) : null;
}

/**
 * Put worlds authored for the active UI language first without hiding the
 * remaining catalog or changing order inside either group.
 */
export function prioritizeWorldsByLocale(
  worlds: readonly WorldRecord[],
  locale: string | undefined,
): WorldRecord[] {
  const preferredLanguage = worldLanguageIdentity(locale);
  if (!preferredLanguage) return [...worlds];

  const preferred: WorldRecord[] = [];
  const remaining: WorldRecord[] = [];
  for (const world of worlds) {
    (worldLanguageIdentity(world.locale) === preferredLanguage
      ? preferred
      : remaining
    ).push(world);
  }
  return [...preferred, ...remaining];
}

/**
 * Whether selecting a world would make its content language differ from the
 * active interface language. Compare maximized language and script so regional
 * variants remain compatible without collapsing Traditional and Simplified
 * Chinese into one language preference.
 */
export function isWorldLocaleMismatch(
  worldLocale: string | undefined,
  interfaceLocale: string | undefined,
): boolean {
  const world = worldLanguageIdentity(worldLocale);
  const current = worldLanguageIdentity(interfaceLocale);
  return world !== null && current !== null && world !== current;
}

export function worldLanguageBadge(locale: string | undefined): string | null {
  const language = worldLanguage(locale);
  return language?.toUpperCase() ?? null;
}

/** Resolve a world language name in the active interface locale. */
export function worldLanguageName(
  locale: string | undefined,
  interfaceLocale: string | undefined,
): string | null {
  const code = worldLocaleCode(locale);
  if (!code) return null;
  const language = localeLanguage(code);
  if (!language) return null;

  const registered = localeRegistry.resolve(code);
  if (registered) {
    return (
      resolveI18nText(registered.label, interfaceLocale) ?? registered.code
    );
  }

  try {
    return (
      new Intl.DisplayNames([interfaceLocale ?? DEFAULT_FALLBACK_LOCALE], {
        type: "language",
      }).of(code) ?? code
    );
  } catch {
    return code;
  }
}
