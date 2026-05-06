/**
 * Codex category display metadata. Owned by `codex` plugin.
 *
 * Used by tools (`unlock-codex-entries`, `update-codex-entry`) to enrich the
 * persisted entry payload at write time. The UI (json-render spec) reads
 * `value.categoryMeta` directly so the framework does NOT need a hardcoded
 * category lookup table — the framework stays plugin-agnostic.
 *
 * Shape:
 *   {
 *     displayName: { zh: string; en: string },
 *     icon: string,   // Lucide icon component name (PascalCase)
 *     color: string,  // Semantic color token; UI maps to Tailwind classes
 *   }
 *
 * Categories MUST stay in sync with the enum in `tools/unlock-codex-entries.js`.
 */

/** @typedef {{ displayName: { zh: string, en: string }, icon: string, color: string }} CodexCategoryMeta */

/** @type {Record<string, CodexCategoryMeta>} */
export const CODEX_CATEGORY_METADATA = {
	monster: {
		displayName: { zh: "怪物", en: "Monsters" },
		icon: "Skull",
		color: "red",
	},
	item: {
		displayName: { zh: "物品", en: "Items" },
		icon: "Gem",
		color: "amber",
	},
	location: {
		displayName: { zh: "地点", en: "Locations" },
		icon: "MapPin",
		color: "blue",
	},
	lore: {
		displayName: { zh: "传说", en: "Lore" },
		icon: "ScrollText",
		color: "purple",
	},
	character: {
		displayName: { zh: "人物", en: "Characters" },
		icon: "Users",
		color: "green",
	},
	skill: {
		displayName: { zh: "技能", en: "Skills" },
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
 * (icon `BookOpen`, color `gray`, displayName echoing the raw category) when
 * the category isn't in the known set.
 *
 * @param {string} category
 * @returns {CodexCategoryMeta}
 */
export function getCategoryMetadata(category) {
	const known = CODEX_CATEGORY_METADATA[category];
	if (known) return known;
	return {
		displayName: { zh: category, en: category },
		icon: DEFAULT_CODEX_CATEGORY_META.icon,
		color: DEFAULT_CODEX_CATEGORY_META.color,
	};
}
