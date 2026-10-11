/**
 * `t("some.key", "English text")` and `t("some.key", { defaultValue: "…" })`
 * repeat the en-US catalog text in code. The catalog is what a player reads;
 * the copy in code shows only when the catalog fails to load, and it goes
 * stale when someone edits one of the two. This check requires them to be the
 * same text.
 */

const T_FALLBACK_REGEX =
  /\bt\(\s*"([A-Za-z0-9_.]+)"\s*,\s*(?:\{\s*(?:[^{}]*?,\s*)?defaultValue:\s*)?("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`$]*`)/g;

/** Flatten a catalog to `dotted.key → text`; non-string leaves are left out. */
export function flattenCatalogText(catalog, prefix = "", out = new Map()) {
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenCatalogText(value, path, out);
    } else if (typeof value === "string") {
      out.set(path, value);
    }
  }
  return out;
}

function literalText(raw) {
  if (raw.startsWith('"')) return JSON.parse(raw);
  // Prettier writes a single-quoted or template literal only when the text has
  // a double quote in it, so undoing the quote escape is enough.
  return raw.slice(1, -1).replace(/\\(['`])/g, "$1");
}

/**
 * Fallback literals in `source` that differ from the catalog text of their
 * key. Pass source with comments blanked out. A key the catalog does not have
 * is not reported here: the missing-key check owns that.
 */
export function findFallbackMismatches(source, english) {
  const problems = [];
  for (const match of source.matchAll(T_FALLBACK_REGEX)) {
    const key = match[1];
    const expected = english.get(key);
    if (expected === undefined) continue;
    const actual = literalText(match[2]);
    if (actual === expected) continue;
    const line = source.slice(0, match.index).split("\n").length;
    problems.push({ key, line, actual, expected });
  }
  return problems;
}
