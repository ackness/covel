/**
 * catalog-constants — shared lookup maps used across core-renderers
 * and card-renderers. Extracted to avoid re-defining them in each
 * component and to give them a single source of truth.
 */

/** Maps gap size names to Tailwind gap classes. */
export const gapClasses: Record<string, string> = {
  xs: "gap-1",
  sm: "gap-2",
  md: "gap-3",
  lg: "gap-4",
};

/** Maps alignment names to Tailwind items-* classes. */
export const alignClasses: Record<string, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
};

/** Maps justify names to Tailwind justify-* classes. */
export const justifyClasses: Record<string, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
  around: "justify-around",
};

/** Maps icon size names to Tailwind w/h classes. */
export const iconSizeClasses: Record<string, string> = {
  xs: "w-3 h-3",
  sm: "w-4 h-4",
  md: "w-5 h-5",
  lg: "w-6 h-6",
};

/**
 * Maps semantic color names to Badge Tailwind classes
 * (background + text + border).
 */
export const badgeColorMap: Record<string, string> = {
  red: "bg-red-500/10 text-red-600 border-red-500/30",
  amber: "bg-amber-500/10 text-amber-600 border-amber-500/30",
  blue: "bg-blue-500/10 text-blue-600 border-blue-500/30",
  green: "bg-green-500/10 text-green-600 border-green-500/30",
  purple: "bg-purple-500/10 text-purple-600 border-purple-500/30",
  cyan: "bg-cyan-500/10 text-cyan-600 border-cyan-500/30",
};

/**
 * Maps rarity names to band tone values used on EntryCard's data-tone
 * attribute.
 */
export const rarityTone: Record<string, string> = {
  legendary: "warning",
  rare: "info",
  uncommon: "info",
  common: "muted",
};

/**
 * Maps rarity names to CSS custom property values used as the band
 * marker color on EntryCard.
 */
export const rarityMarkerColor: Record<string, string> = {
  legendary: "var(--accent-warning)",
  rare: "var(--accent-secondary)",
  uncommon: "var(--accent-secondary)",
  common: "var(--color-border)",
};

/**
 * Maps rarity names to badge Tailwind classes used inside EntryCard.
 */
export const rarityBadgeColors: Record<string, string> = {
  legendary: "bg-amber-500/10 text-amber-600 border-amber-500/30",
  rare: "bg-purple-500/10 text-purple-600 border-purple-500/30",
  uncommon: "bg-blue-500/10 text-blue-600 border-blue-500/30",
  common: "bg-muted text-muted-foreground border-border",
};

/**
 * Default fallback icon names for each entry category in EntryCard.
 */
export const categoryIcons: Record<string, string> = {
  monster: "skull",
  item: "gem",
  location: "map-pin",
  lore: "scroll-text",
  character: "users",
  skill: "sparkles",
};

/**
 * Maps color names to Tailwind text color classes for category icons
 * in EntryCard.
 */
export const categoryIconColors: Record<string, string> = {
  red: "text-red-500 dark:text-red-400",
  amber: "text-amber-500 dark:text-amber-400",
  blue: "text-blue-500 dark:text-blue-400",
  green: "text-green-500 dark:text-green-400",
  purple: "text-purple-500 dark:text-purple-400",
  cyan: "text-cyan-500 dark:text-cyan-400",
};
