/**
 * Codex category display metadata. Owned by `codex` plugin.
 *
 * Used by `sync-codex-entries` to enrich the persisted entry payload at
 * write time. The UI (json-render spec) reads
 * `value.categoryMeta` directly so the framework does NOT need a hardcoded
 * category lookup table — the framework stays plugin-agnostic.
 *
 * Shape:
 *   {
 *     icon: string,   // Lucide icon component name (PascalCase)
 *     color: string,  // Semantic color token; UI maps to Tailwind classes
 *   }
 *
 * The category's name is not stored. Entries are injected into this plugin's
 * prompt, and a name stored in two languages put both in front of the model.
 * The panel takes the names from its filter tabs.
 *
 * Categories MUST stay in sync with the enum in `tools/sync-codex-entries.js`.
 */

/** @typedef {{ icon: string, color: string }} CodexCategoryMeta */

/** @type {Record<string, CodexCategoryMeta>} */
export const CODEX_CATEGORY_METADATA = {
  monster: {
    icon: "Skull",
    color: "red",
  },
  item: {
    icon: "Gem",
    color: "amber",
  },
  location: {
    icon: "MapPin",
    color: "blue",
  },
  lore: {
    icon: "ScrollText",
    color: "purple",
  },
  character: {
    icon: "Users",
    color: "green",
  },
  skill: {
    icon: "Sparkles",
    color: "cyan",
  },
};

/** Default metadata for unknown categories. Keeps UI from breaking. */
export const DEFAULT_CODEX_CATEGORY_META = Object.freeze({
  icon: "BookOpen",
  color: "gray",
});

/**
 * Look up display metadata for a category. Falls back to a generic shape
 * (icon `BookOpen`, color `gray`) when the category isn't in the known set.
 *
 * @param {string} category
 * @returns {CodexCategoryMeta}
 */
export function getCategoryMetadata(category) {
  const known = CODEX_CATEGORY_METADATA[category];
  if (known) return known;
  return {
    icon: DEFAULT_CODEX_CATEGORY_META.icon,
    color: DEFAULT_CODEX_CATEGORY_META.color,
  };
}
