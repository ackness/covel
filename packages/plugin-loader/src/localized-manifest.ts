/**
 * Reconcile a `PLUGIN.zh.md` / `RUNTIME.zh.md` variant against the canonical
 * English manifest.
 *
 * A locale variant is a TRANSLATION, not a fork. Only natural-language fields
 * (description, display names, author's-note / post-history prose, …) may
 * differ; everything else is the runtime's execution contract — priority,
 * triggers, capabilities, tool whitelist, inject declarations, data schemas.
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
 * Keys whose values are prose meant for humans/LLMs. Matched at any depth, so
 * nested `description` / `label` fields (userSettings, events, dataSchemas,
 * actions, prompt contributions) are translatable without listing every container.
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

  if (isPlainObject(canonical) && isPlainObject(localized)) {
    const out: Record<string, unknown> = {};
    for (const key of new Set([
      ...Object.keys(canonical),
      ...Object.keys(localized),
    ])) {
      const childPath = path ? `${path}.${key}` : key;
      const value = NATURAL_LANGUAGE_KEYS.has(key)
        ? (localized[key] ?? canonical[key])
        : reconcileValue(canonical[key], localized[key], childPath, drift);
      if (value !== undefined) out[key] = value;
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

  if (JSON.stringify(canonical) !== JSON.stringify(localized)) {
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
