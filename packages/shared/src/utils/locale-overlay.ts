import { isLocaleMap, resolveI18nText } from "./i18n.js";
import { localesShareLanguageAndScript } from "./locale-registry.js";

/**
 * Sparse locale overlays.
 *
 * A package's main file is written in one language. `<name>.<locale>.<ext>`
 * beside it holds only the translated text. Objects merge by key, lists of
 * objects by `id` (by position when the items have none), so an overlay never
 * repeats structure and cannot change it.
 *
 * Two results come from the same merge:
 * - `compile`: every translated leaf becomes a locale map
 *   (`{ "zh-CN": …, "en-US": … }`), the form labels have at runtime, where
 *   each viewer picks a language.
 * - `resolve`: the overlay's text replaces the main file's, giving plain data
 *   in one language. This is how content reaches a session, which holds one
 *   language.
 */
export type LocaleOverlayMode = "compile" | "resolve";

export interface LocaleOverlayIssue {
  /** Dot path of the offending overlay entry. */
  readonly path: string;
  readonly message: string;
}

export interface ApplyLocaleOverlayOptions {
  readonly mode: LocaleOverlayMode;
  /** Locale of the overlay. */
  readonly locale: string;
  /** Locale of the main file. Names the main text in a compiled map. */
  readonly baseLocale: string;
  /**
   * Field that identifies an array element. Default `id`. With a list, the
   * first field that every element of an array has is used for that array
   * (a manifest names commands by `name` and settings by `key`).
   */
  readonly arrayKey?: string | readonly string[];
}

type Json = unknown;

function isPlainObject(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describe(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * A locale map that belongs to a package written in `baseLocale`: every key
 * is a locale code, every value a string, and one key is the base language.
 *
 * The base-language key matters. Short field names are also language codes
 * (`id` is Indonesian, `to` Tongan, `no` Norwegian), so `{ id: "fogRot" }`
 * alone looks like a locale map.
 */
export function isLocaleMapFor(
  value: unknown,
  baseLocale: string,
): value is Record<string, string> {
  return (
    isLocaleMap(value) &&
    Object.keys(value).some(
      (key) =>
        key.toLowerCase() === baseLocale.toLowerCase() ||
        localesShareLanguageAndScript(key, baseLocale),
    )
  );
}

/** The element key shared by every object in `items`, if there is one. */
function elementKey(
  items: readonly Json[],
  arrayKey: string | readonly string[],
): string | null {
  if (items.length === 0) return null;
  for (const key of typeof arrayKey === "string" ? [arrayKey] : arrayKey)
    if (
      items.every(
        (item) =>
          isPlainObject(item) &&
          (typeof item[key] === "string" || typeof item[key] === "number"),
      )
    )
      return key;
  return null;
}

/**
 * Merge one locale's overlay into a main value.
 *
 * The result is always returned; `issues` lists every overlay entry that was
 * ignored: an unknown key or id, text where the main file has structure, or a
 * non-text value that differs from the main file.
 */
export function applyLocaleOverlay(
  base: Json,
  overlay: Json,
  options: ApplyLocaleOverlayOptions,
): { value: Json; issues: LocaleOverlayIssue[] } {
  const issues: LocaleOverlayIssue[] = [];
  const arrayKey = options.arrayKey ?? "id";
  const compile = options.mode === "compile";
  const report = (path: string, message: string) =>
    issues.push({ path: path || "(root)", message });

  function merge(main: Json, extra: Json, path: string): Json {
    if (extra === undefined || extra === null) return main;

    if (typeof extra === "string") {
      if (typeof main === "string") {
        // The same text in both files needs no map (ids copied for matching).
        if (!compile || extra === main) return compile ? main : extra;
        return { [options.baseLocale]: main, [options.locale]: extra };
      }
      if (isLocaleMapFor(main, options.baseLocale))
        return compile ? { ...main, [options.locale]: extra } : extra;
      report(path, `gives text where the main file has ${describe(main)}`);
      return main;
    }

    if (Array.isArray(extra)) {
      if (!Array.isArray(main)) {
        report(path, `gives a list where the main file has ${describe(main)}`);
        return main;
      }
      const key = elementKey(main, arrayKey);
      if (key && elementKey(extra, key)) {
        const next = [...main];
        for (const item of extra as Record<string, Json>[]) {
          const index = main.findIndex(
            (candidate) =>
              (candidate as Record<string, Json>)[key] === item[key],
          );
          if (index < 0) {
            report(
              `${path}[${key}=${String(item[key])}]`,
              "has no entry with this id in the main file",
            );
            continue;
          }
          const { [key]: _identity, ...rest } = item;
          next[index] = merge(
            main[index],
            rest,
            `${path}[${key}=${String(item[key])}]`,
          );
        }
        return next;
      }
      // A list of plain texts is one unit in a single language: the overlay's
      // list is the translation, whatever its length. `null` keeps an item.
      if (
        !compile &&
        [...main, ...extra].every(
          (item) => !isPlainObject(item) && !Array.isArray(item),
        )
      )
        return extra.map((item, index) => item ?? main[index] ?? null);
      if (extra.length > main.length)
        report(
          path,
          `has ${extra.length} items; the main file has ${main.length}`,
        );
      return main.map((item, index) =>
        merge(item, extra[index], `${path}[${index}]`),
      );
    }

    if (isPlainObject(extra)) {
      const mainIsText = isLocaleMapFor(main, options.baseLocale);
      if (!isPlainObject(main) || mainIsText) {
        report(
          path,
          `gives an object where the main file has ${mainIsText ? "text" : describe(main)}`,
        );
        return main;
      }
      const next: Record<string, Json> = { ...main };
      for (const [name, value] of Object.entries(extra)) {
        const childPath = path ? `${path}.${name}` : name;
        if (!Object.hasOwn(main, name)) {
          report(childPath, "is not in the main file");
          continue;
        }
        next[name] = merge(main[name], value, childPath);
      }
      return next;
    }

    // Numbers and booleans are not text. A full copy of the main file repeats
    // them, which is fine; a different value is a change of data.
    if (extra !== main)
      report(
        path,
        `changes ${describe(main)}; an overlay may only translate text`,
      );
    return main;
  }

  return { value: merge(base, overlay, ""), issues };
}

/** The text of a locale map that belongs to `baseLocale`, and its key. */
function baseEntry(
  map: Readonly<Record<string, string>>,
  baseLocale: string,
): [key: string, text: string] {
  const exact = Object.keys(map).find(
    (key) => key.toLowerCase() === baseLocale.toLowerCase(),
  );
  const key =
    exact ??
    Object.keys(map).find((candidate) =>
      localesShareLanguageAndScript(candidate, baseLocale),
    ) ??
    Object.keys(map)[0]!;
  return [key, resolveI18nText(map, key) ?? map[key]!];
}

/**
 * Every inline locale map in a main file, by path. An authored file holds one
 * language; its translations belong in overlay files.
 */
export function findInlineLocaleMaps(
  value: Json,
  baseLocale: string,
): { path: string; locales: string[] }[] {
  const found: { path: string; locales: string[] }[] = [];
  function visit(node: Json, path: string): void {
    if (isLocaleMapFor(node, baseLocale)) {
      found.push({ path: path || "(root)", locales: Object.keys(node) });
      return;
    }
    if (Array.isArray(node))
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
    else if (isPlainObject(node))
      for (const [name, child] of Object.entries(node))
        visit(child, path ? `${path}.${name}` : name);
  }
  visit(value, "");
  return found;
}

/**
 * The reverse of `compile`: take a value that holds inline locale maps and
 * return the main value in `baseLocale` plus one sparse overlay per other
 * locale. Used to move a package from inline maps to overlay files.
 */
export function splitLocaleMaps(
  value: Json,
  baseLocale: string,
  arrayKey: string | readonly string[] = "id",
): { base: Json; overlays: Record<string, Json> } {
  const overlays: Record<string, Json> = {};

  function split(node: Json): { base: Json; byLocale: Map<string, Json> } {
    const byLocale = new Map<string, Json>();
    if (isLocaleMapFor(node, baseLocale)) {
      const [baseKey, text] = baseEntry(node, baseLocale);
      for (const [locale, translation] of Object.entries(node))
        if (locale !== baseKey && translation !== text)
          byLocale.set(locale, translation);
      return { base: text, byLocale };
    }
    if (Array.isArray(node)) {
      const parts = node.map(split);
      const key = elementKey(node, arrayKey);
      const locales = new Set(
        parts.flatMap((part) => [...part.byLocale.keys()]),
      );
      for (const locale of locales) {
        const items = parts.map((part) => part.byLocale.get(locale));
        if (key) {
          byLocale.set(
            locale,
            items.flatMap((item, index) =>
              item === undefined
                ? []
                : [
                    {
                      [key]: (node[index] as Record<string, Json>)[key],
                      ...(item as Record<string, Json>),
                    },
                  ],
            ),
          );
        } else {
          // ES2022 target: no findLastIndex.
          let last = items.length - 1;
          while (last >= 0 && items[last] === undefined) last--;
          byLocale.set(
            locale,
            items.slice(0, last + 1).map((item) => item ?? null),
          );
        }
      }
      return { base: parts.map((part) => part.base), byLocale };
    }
    if (isPlainObject(node)) {
      const base: Record<string, Json> = {};
      for (const [name, child] of Object.entries(node)) {
        const part = split(child);
        base[name] = part.base;
        for (const [locale, translated] of part.byLocale) {
          const target = (byLocale.get(locale) ?? {}) as Record<string, Json>;
          target[name] = translated;
          byLocale.set(locale, target);
        }
      }
      return { base, byLocale };
    }
    return { base: node, byLocale };
  }

  const result = split(value);
  for (const [locale, overlay] of result.byLocale) overlays[locale] = overlay;
  return { base: result.base, overlays };
}
