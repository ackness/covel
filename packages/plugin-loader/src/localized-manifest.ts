/**
 * Reconcile a localized `PLUGIN.<locale>.md` manifest against the canonical
 * `PLUGIN.md`.
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

import type { RuntimeManifest } from "@covel/shared";

/**
 * Keys whose values are prose meant for humans/LLMs. Matched at any depth, so
 * nested `description` / `label` fields (userSettings, events, dataSchemas,
 * rpc, memoryBlocks) are translatable without listing every container.
 */
const NATURAL_LANGUAGE_KEYS: ReadonlySet<string> = new Set([
  "description",
  "displayName",
  "label",
  "title",
  "placeholder",
  "hint",
  "content",
  "prompt",
  "extractionPrompt",
  "summaryFocus",
  "i18n",
]);

/**
 * Field paths whose key is in NATURAL_LANGUAGE_KEYS but that are a stable
 * machine identifier at that specific location, not display text. They must be
 * taken from the canonical file so a translation can't change them.
 *
 * `memoryBlocks[*].label` is a working_memory key / prompt XML tag / plugin-data
 * mirror key (the human-facing name is `displayName`); translating it would
 * split a memory block's key per UI language.
 */
const MACHINE_FIELD_PATHS: readonly RegExp[] = [/^memoryBlocks\[\d+\]\.label$/];

function isMachineFieldPath(path: string): boolean {
  return MACHINE_FIELD_PATHS.some((re) => re.test(path));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reconcileValue(
  canonical: unknown,
  localized: unknown,
  path: string,
  drift: string[],
): unknown {
  if (isPlainObject(canonical) && isPlainObject(localized)) {
    const out: Record<string, unknown> = {};
    for (const key of new Set([
      ...Object.keys(canonical),
      ...Object.keys(localized),
    ])) {
      const childPath = path ? `${path}.${key}` : key;
      const value =
        NATURAL_LANGUAGE_KEYS.has(key) && !isMachineFieldPath(childPath)
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
export function reconcileLocalizedManifest(
  canonical: RuntimeManifest,
  localized: RuntimeManifest,
  localizedPath: string,
): RuntimeManifest {
  const drift: string[] = [];
  const merged = reconcileValue(
    canonical,
    localized,
    "",
    drift,
  ) as RuntimeManifest;

  if (drift.length > 0) {
    console.warn(
      `[plugin-loader] ${localizedPath}: locale variant diverges from PLUGIN.md on non-translatable field(s) ${drift.join(", ")} — ` +
        `using the canonical values. A locale file may only translate prose; move contract changes into PLUGIN.md.`,
    );
  }

  return merged;
}
