import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalizeLocale,
  DEFAULT_FALLBACK_LOCALE,
  LOCALE_DEFINITIONS,
} from "@covel/shared";

const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;

export function canonicalizeCatalogLocale(value) {
  return typeof value === "string" ? canonicalizeLocale(value) : undefined;
}

export function builtInAliasOwner(locale, availableCodes) {
  const canonical = canonicalizeCatalogLocale(locale);
  if (!canonical) return undefined;
  const normalizedCodes = new Set(
    availableCodes
      .map(canonicalizeCatalogLocale)
      .filter((code) => code !== undefined),
  );
  for (const definition of LOCALE_DEFINITIONS) {
    if (!normalizedCodes.has(definition.code)) continue;
    if (
      definition.aliases?.some(
        (alias) => canonicalizeCatalogLocale(alias) === canonical,
      )
    ) {
      return definition.code;
    }
  }
  return undefined;
}

function leafType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function flattenCatalogShape(value, prefix = "", out = new Map()) {
  if (Array.isArray(value)) {
    out.set(prefix, { type: "array", value });
    value.forEach((item, index) => {
      flattenCatalogShape(item, `${prefix}[${index}]`, out);
    });
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      flattenCatalogShape(item, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out.set(prefix, { type: leafType(value), value });
  return out;
}

function interpolationTokens(value) {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)]
    .map((match) => match[1])
    .sort();
}

function pluralBaseKey(key) {
  const match = PLURAL_SUFFIX_RE.exec(key);
  if (!match) return undefined;
  return { baseKey: key.slice(0, -match[0].length), category: match[1] };
}

function explicitPluralBasesIn(catalogShape) {
  const bases = new Map();
  for (const [key, leaf] of catalogShape) {
    const plural = pluralBaseKey(key);
    if (!plural || !catalogShape.has(plural.baseKey)) continue;
    const variants = bases.get(plural.baseKey) ?? new Map();
    variants.set(plural.category, leaf);
    bases.set(plural.baseKey, variants);
  }
  return bases;
}

function pluralBasesIn(catalogShape) {
  const bases = explicitPluralBasesIn(catalogShape);
  for (const [key, leaf] of catalogShape) {
    if (
      !pluralBaseKey(key) &&
      leaf.type === "string" &&
      interpolationTokens(leaf.value).includes("count") &&
      !bases.has(key)
    ) {
      bases.set(key, new Map());
    }
  }
  return bases;
}

function requiredPluralCategories(locale) {
  return new Intl.PluralRules(locale)
    .resolvedOptions()
    .pluralCategories.filter((category) => category !== "other");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Add required locale-specific forms for plural bases marked by English. */
export function createLocaleCatalogTemplate(fallbackCatalog, locale) {
  const canonicalLocale = canonicalizeCatalogLocale(locale);
  if (!canonicalLocale) throw new Error(`Invalid locale: ${String(locale)}`);
  const catalog = cloneJson(fallbackCatalog);
  const categories = requiredPluralCategories(canonicalLocale);

  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;

    const bases = new Set();
    for (const key of Object.keys(value)) {
      const plural = pluralBaseKey(key);
      if (plural && Object.hasOwn(value, plural.baseKey)) {
        bases.add(plural.baseKey);
      }
    }
    for (const baseKey of bases) {
      for (const category of categories) {
        const key = `${baseKey}_${category}`;
        if (Object.hasOwn(value, key)) continue;
        const categorySource = value[key] ?? value[baseKey];
        value[key] = cloneJson(categorySource);
      }
    }
    Object.values(value).forEach(visit);
  }

  visit(catalog);
  return catalog;
}

function checkLeafCompatibility(
  problems,
  locale,
  key,
  actualLeaf,
  expectedLeaf,
) {
  if (actualLeaf.type !== expectedLeaf.type) {
    problems.push(
      `${locale}.json key "${key}" has type ${actualLeaf.type}; expected ${expectedLeaf.type}`,
    );
    return;
  }
  const expectedTokens = interpolationTokens(expectedLeaf.value);
  const actualTokens = interpolationTokens(actualLeaf.value);
  if (expectedTokens.join("\0") !== actualTokens.join("\0")) {
    problems.push(
      `${locale}.json key "${key}" has interpolation tokens [${actualTokens.join(", ")}]; expected [${expectedTokens.join(", ")}]`,
    );
  }
}

/** Validate every contributed catalog against the canonical English shape. */
export function checkLocaleCatalogs(localesRoot) {
  const localeFiles = readdirSync(localesRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  const problems = [];
  const canonicalOwners = new Map();
  const canonicalByLocale = new Map();
  for (const locale of localeFiles) {
    const canonical = canonicalizeCatalogLocale(locale);
    if (!canonical) {
      problems.push(`${locale}.json is not a safe BCP 47 locale filename`);
      continue;
    }
    canonicalByLocale.set(locale, canonical);
    const existing = canonicalOwners.get(canonical);
    if (existing) {
      problems.push(
        `locale catalogs ${existing}.json and ${locale}.json resolve to the same locale ${canonical}`,
      );
    } else {
      canonicalOwners.set(canonical, locale);
    }
  }

  for (const [locale, canonical] of canonicalByLocale) {
    const owner = builtInAliasOwner(canonical, [...canonicalOwners.keys()]);
    if (owner) {
      problems.push(
        `${locale}.json conflicts with built-in locale alias ${canonical} owned by ${owner}.json`,
      );
    }
  }

  const fallbackLocale = DEFAULT_FALLBACK_LOCALE;
  if (!localeFiles.includes(fallbackLocale)) {
    problems.push(
      `required fallback catalog ${fallbackLocale}.json is missing`,
    );
    return problems;
  }

  const fallback = JSON.parse(
    readFileSync(resolve(localesRoot, `${fallbackLocale}.json`), "utf8"),
  );
  const expected = flattenCatalogShape(fallback);
  const pluralBases = pluralBasesIn(expected);
  const requiredPluralBases = explicitPluralBasesIn(expected);
  for (const locale of localeFiles) {
    const path = resolve(localesRoot, `${locale}.json`);
    const actual = flattenCatalogShape(JSON.parse(readFileSync(path, "utf8")));
    for (const [key, expectedLeaf] of expected) {
      const expectedPlural = pluralBaseKey(key);
      if (expectedPlural && pluralBases.has(expectedPlural.baseKey)) continue;
      const actualLeaf = actual.get(key);
      if (!actualLeaf) {
        problems.push(`${locale}.json is missing catalog key "${key}"`);
        continue;
      }
      checkLeafCompatibility(problems, locale, key, actualLeaf, expectedLeaf);
    }

    const canonicalLocale = canonicalByLocale.get(locale);
    const requiredCategories = canonicalLocale
      ? requiredPluralCategories(canonicalLocale)
      : [];
    if (canonicalLocale) {
      for (const baseKey of requiredPluralBases.keys()) {
        for (const category of requiredCategories) {
          const key = `${baseKey}_${category}`;
          if (!actual.has(key)) {
            problems.push(
              `${locale}.json is missing plural category "${category}" for catalog key "${baseKey}"`,
            );
          }
        }
      }
    }
    for (const [key, actualLeaf] of actual) {
      const actualPlural = pluralBaseKey(key);
      if (!actualPlural) continue;
      const englishVariants = pluralBases.get(actualPlural.baseKey);
      if (!englishVariants) continue;
      checkLeafCompatibility(
        problems,
        locale,
        key,
        actualLeaf,
        englishVariants.get(actualPlural.category) ??
          expected.get(actualPlural.baseKey),
      );
    }
    for (const key of actual.keys()) {
      if (!expected.has(key)) {
        const actualPlural = pluralBaseKey(key);
        if (actualPlural && pluralBases.has(actualPlural.baseKey)) continue;
        problems.push(`${locale}.json has unknown catalog key "${key}"`);
      }
    }
  }
  return problems;
}
