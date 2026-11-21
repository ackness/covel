import { isDeepStrictEqual } from "node:util";
import { isLocaleMap } from "@covel/shared";

/**
 * Reconcile a `PLUGIN.zh.md` / `RUNTIME.zh.md` variant against the canonical
 * English manifest.
 *
 * A locale variant is a TRANSLATION, not a fork. Only natural-language fields
 * (description, display names, author's-note / post-history prose, …) may
 * differ; everything else is the runtime's execution contract — stage,
 * triggers, contracts, tool whitelist, inject declarations, data schemas.
 * Translations drift in practice, and a drifted structural field means the
 * same runtime schedules differently, or reaches different tools, depending on
 * the player's UI language.
 *
 * So structural fields are taken from the canonical file by construction and
 * each divergence is reported once at load time. A translation typo therefore
 * degrades to "this plugin behaves like the canonical one" instead of either
 * breaking the plugin or silently changing its contract.
 */

/**
 * Keys whose values are prose meant for humans/LLMs. Matched at any depth
 * outside structural/author-keyed containers, and only when the canonical
 * value itself is prose (not a structural subtree).
 */
const NATURAL_LANGUAGE_KEYS: ReadonlySet<string> = new Set([
  "description",
  "displayName",
  "label",
  "title",
  "placeholder",
  "hint",
  "content",
  "i18n",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True for a canonical value that holds prose (a plain string or a locale map
 * such as `{ en: "…", zh: "…" }`), as opposed to a structural subtree.
 */
function isCanonicalProse(value: unknown): boolean {
  return typeof value === "string" || isLocaleMap(value);
}

/**
 * Subtrees that are structure all the way down. Their keys are author-chosen
 * identifiers (dataset names, projection IDs, input binding names, contract
 * IDs) or purely structural blocks, so a key named `description`, `title`,
 * `content`, etc. must not be mistaken for a prose field.
 */
const STRUCTURAL_PATHS: ReadonlySet<string> = new Set([
  "contributes.datasets",
  "datasets",
  "contributes.worldProjections",
  "worldProjections",
  "contributes.ui",
  "io.inputs",
  "runtime.io.inputs",
  "inputs",
  "contracts",
]);

/**
 * Author-keyed maps whose immediate keys are identifiers (e.g. data namespace
 * names), while each entry object may still carry translatable prose fields
 * such as `description` or `authoring.title`. Always recurse into their
 * entries rather than treating an entry key like `content` or `i18n` as prose.
 */
const AUTHOR_KEYED_MAP_PATHS: ReadonlySet<string> = new Set([
  "contributes.data",
  "dataSchemas",
]);

function isStructuralPath(path: string): boolean {
  return (
    STRUCTURAL_PATHS.has(path) ||
    /^(?:contributes\.settings|userSettings)\[\d+\]\.default$/.test(path)
  );
}

function reconcileProseField(
  key: string,
  canonical: unknown,
  localized: unknown,
  path: string,
  drift: string[],
): unknown {
  if (localized === undefined) return canonical;

  if (key === "i18n") {
    if (isLocaleMap(canonical) && isLocaleMap(localized)) {
      return localized;
    }
    return reconcileValue(canonical, localized, path, drift);
  }

  if (isCanonicalProse(canonical)) {
    if (localized === null) return canonical;
    if (
      typeof localized === "string" ||
      isLocaleMap(localized) ||
      (!isPlainObject(localized) && !Array.isArray(localized))
    ) {
      // Primitive typos (e.g. `description: 42`) pass through so schema
      // validation reports the bad translation, while non-locale objects and
      // arrays cannot overwrite or inject structure.
      return localized;
    }
  }

  return reconcileValue(canonical, localized, path, drift);
}

function reconcileValue(
  canonical: unknown,
  localized: unknown,
  path: string,
  drift: string[],
): unknown {
  // A translation that simply omits a field inherits it — that is the intended
  // shape of a locale variant, not a divergence. Treating omission as drift is
  // what forced every locale file to mirror the whole manifest, and mirrored
  // manifests are precisely what goes stale as the canonical one evolves.
  // A field the translation DECLARES differently is still reported below.
  if (localized === undefined) return canonical;

  if (isStructuralPath(path)) {
    if (!isDeepStrictEqual(canonical, localized)) drift.push(path);
    return canonical;
  }

  if (isPlainObject(canonical) && isPlainObject(localized)) {
    const isAuthorKeyedMap = AUTHOR_KEYED_MAP_PATHS.has(path);
    const out: Record<string, unknown> = {};
    for (const key of new Set([
      ...Object.keys(canonical),
      ...Object.keys(localized),
    ])) {
      const childPath = path ? `${path}.${key}` : key;
      const canonVal = Object.hasOwn(canonical, key)
        ? canonical[key]
        : undefined;
      const locVal = Object.hasOwn(localized, key) ? localized[key] : undefined;
      const value =
        !isAuthorKeyedMap && NATURAL_LANGUAGE_KEYS.has(key)
          ? reconcileProseField(key, canonVal, locVal, childPath, drift)
          : reconcileValue(canonVal, locVal, childPath, drift);
      if (value !== undefined) {
        if (key === "__proto__") {
          Object.defineProperty(out, key, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        } else {
          out[key] = value;
        }
      }
    }
    return out;
  }

  if (
    Array.isArray(canonical) &&
    Array.isArray(localized) &&
    canonical.length === localized.length
  ) {
    return canonical.map((item, i) =>
      reconcileValue(item, localized[i], `${path}[${i}]`, drift),
    );
  }

  if (!isDeepStrictEqual(canonical, localized)) {
    drift.push(path);
  }
  return canonical;
}

/**
 * Merge a localized manifest onto its canonical counterpart: natural-language
 * fields come from the translation, everything else from the canonical file.
 * Structural differences are warned about once, naming each drifted field path.
 */
export function reconcileLocalizedManifest<T extends object>(
  canonical: T,
  localized: object,
  localizedPath: string,
): T {
  const drift: string[] = [];
  const merged = reconcileValue(canonical, localized, "", drift) as T;

  if (drift.length > 0) {
    console.warn(
      `[plugin-loader] ${localizedPath}: locale variant diverges from PLUGIN.md on non-translatable field(s) ${drift.join(", ")} — ` +
        `using the canonical values. A locale file may only translate prose; move contract changes into PLUGIN.md.`,
    );
  }

  return merged;
}
