import {
  DEFAULT_FALLBACK_LOCALE,
  DEFAULT_LOCALE,
  LOCALE_DEFINITIONS as BUILT_IN_LOCALE_DEFINITIONS,
  canonicalizeLocale,
  defineLocaleRegistry,
  localeLanguage,
  normalizeLocale,
  type I18nText,
  type LocaleDefinition,
} from "@covel/shared";

export type SupportedLocale = string;

type TranslationCatalog = Record<string, unknown>;

type LocaleCatalogLoader = () => Promise<unknown>;
type TranslationCatalogLoader = () => Promise<TranslationCatalog>;

export type LocaleCatalogModules = Readonly<
  Record<string, unknown | LocaleCatalogLoader>
>;

export interface WebLocaleCatalog {
  readonly definitions: readonly LocaleDefinition[];
  readonly codes: readonly SupportedLocale[];
  readonly registry: ReturnType<typeof defineLocaleRegistry>;
  loadCatalog(locale: string): Promise<TranslationCatalog>;
}

const CATALOG_PATH_PATTERN = /(?:^|\/)locales\/([^/]+)\.json$/u;

function catalogCodeFromPath(path: string): string {
  const rawCode = CATALOG_PATH_PATTERN.exec(path)?.[1];
  if (!rawCode) {
    throw new Error(
      `Locale catalog path must match locales/<BCP47>.json: ${path}`,
    );
  }

  const canonicalCode = canonicalizeLocale(rawCode);
  if (canonicalCode) return canonicalCode;
  throw new Error(`Invalid BCP 47 locale catalog filename: ${path}`);
}

function translationCatalog(value: unknown, path: string): TranslationCatalog {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Locale catalog must export a JSON object: ${path}`);
  }
  return value as TranslationCatalog;
}

function displayLanguageName(locale: string, displayLocale: string): string {
  try {
    return (
      new Intl.DisplayNames([displayLocale, DEFAULT_FALLBACK_LOCALE], {
        type: "language",
      }).of(locale) ?? locale
    );
  } catch {
    return locale;
  }
}

function createLocaleDefinition(
  code: string,
  availableCodes: readonly string[],
): LocaleDefinition {
  const label = Object.fromEntries(
    availableCodes.map((displayLocale) => [
      displayLocale,
      displayLanguageName(code, displayLocale),
    ]),
  ) as I18nText;

  return {
    code,
    label,
    shortLabel: (localeLanguage(code) ?? code).toUpperCase(),
    fallbackLocales:
      normalizeLocale(code) === normalizeLocale(DEFAULT_FALLBACK_LOCALE)
        ? []
        : [DEFAULT_FALLBACK_LOCALE],
  };
}

function extendBuiltInLabels(
  definition: LocaleDefinition,
  availableCodes: readonly string[],
): LocaleDefinition {
  if (typeof definition.label === "string") return definition;

  const generatedLabels = Object.fromEntries(
    availableCodes.map((displayLocale) => [
      displayLocale,
      displayLanguageName(definition.code, displayLocale),
    ]),
  );
  return {
    ...definition,
    label: { ...generatedLabels, ...definition.label },
  };
}

/**
 * Build Web locale metadata and lazy i18next loaders from discovered JSON
 * modules. A valid `locales/<BCP47>.json` filename is the only declaration a
 * new Web locale needs.
 */
export function buildWebLocaleCatalog(
  modules: LocaleCatalogModules,
): WebLocaleCatalog {
  const catalogLoadersByCode = new Map<string, TranslationCatalogLoader>();

  for (const [path, value] of Object.entries(modules)) {
    const code = catalogCodeFromPath(path);
    const normalizedCode = normalizeLocale(code);
    if (catalogLoadersByCode.has(normalizedCode)) {
      throw new Error(`Duplicate locale catalog for ${code}: ${path}`);
    }
    const loader =
      typeof value === "function"
        ? (value as LocaleCatalogLoader)
        : async () => value;
    catalogLoadersByCode.set(normalizedCode, async () =>
      translationCatalog(await loader(), path),
    );
  }

  for (const requiredCode of [DEFAULT_LOCALE, DEFAULT_FALLBACK_LOCALE]) {
    if (!catalogLoadersByCode.has(normalizeLocale(requiredCode))) {
      throw new Error(
        `Required Web locale catalog is missing: ${requiredCode}`,
      );
    }
  }

  const catalogCodes = [...catalogLoadersByCode.keys()].map((normalizedCode) =>
    canonicalizeLocale(normalizedCode)!,
  );
  const builtInCatalogDefinitions = BUILT_IN_LOCALE_DEFINITIONS.filter(
    (definition) => catalogLoadersByCode.has(normalizeLocale(definition.code)),
  );
  const builtInAliases = new Map<string, string>();
  for (const definition of builtInCatalogDefinitions) {
    for (const alias of definition.aliases ?? []) {
      builtInAliases.set(normalizeLocale(alias), definition.code);
    }
  }
  const builtInCodes = new Set(
    builtInCatalogDefinitions.map((definition) =>
      normalizeLocale(definition.code),
    ),
  );
  const contributedCodes = catalogCodes
    .filter((code) => !builtInCodes.has(normalizeLocale(code)))
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const code of contributedCodes) {
    const owner = builtInAliases.get(normalizeLocale(code));
    if (owner) {
      throw new Error(
        `Locale catalog code ${code} conflicts with built-in alias for ${owner}; use a distinct canonical locale code`,
      );
    }
  }
  const codes = [
    ...builtInCatalogDefinitions.map((definition) => definition.code),
    ...contributedCodes,
  ];
  const builtInDefinitions = builtInCatalogDefinitions.map((definition) =>
    extendBuiltInLabels(definition, codes),
  );
  const firstDefinition = builtInDefinitions[0];
  if (!firstDefinition) {
    throw new Error("Web locale registry requires a built-in default locale");
  }
  const definitions: [LocaleDefinition, ...LocaleDefinition[]] = [
    firstDefinition,
    ...builtInDefinitions.slice(1),
    ...contributedCodes.map((code) => createLocaleDefinition(code, codes)),
  ];
  const registry = defineLocaleRegistry(definitions, {
    defaultLocale: DEFAULT_LOCALE,
    fallbackLocale: DEFAULT_FALLBACK_LOCALE,
  });
  async function loadCatalog(locale: string): Promise<TranslationCatalog> {
    const code = registry.match(locale)?.code ?? canonicalizeLocale(locale);
    const loader = code
      ? catalogLoadersByCode.get(normalizeLocale(code))
      : undefined;
    if (!loader) throw new Error(`No Web locale catalog for ${locale}`);
    return loader();
  }

  return Object.freeze({
    definitions: registry.definitions,
    codes: registry.codes,
    registry,
    loadCatalog,
  });
}

const catalogModules = import.meta.glob("./locales/*.json", {
  import: "default",
});

export const webLocaleCatalog = buildWebLocaleCatalog(catalogModules);
export const localeDefinitions = webLocaleCatalog.definitions;
export const supportedLocales = webLocaleCatalog.codes;
export const localeRegistry = webLocaleCatalog.registry;
