/**
 * Affinity tier metadata (plugin-local).
 *
 * Single source of truth for the score range, the six tier bands, and the
 * per-tier display metadata (I18nText label + Badge color). The tool derives
 * `tier` / `tierLabel` / `tierColor` from the cumulative score on every
 * write, so the UI (json-render spec) renders tier badges without any
 * framework-side lookup table — same pattern as codex's category-metadata.js.
 */

export const AFFINITY_MIN = -100;
export const AFFINITY_MAX = 100;

/**
 * Tier bands over the clamped score range. Bands are contiguous and cover
 * [-100, 100] completely, so `getTier` always resolves after clamping.
 */
export const AFFINITY_TIERS = [
  {
    id: "hostile",
    min: -100,
    max: -60,
    label: { zh: "敌视", en: "Hostile" },
    color: "red",
  },
  {
    id: "cold",
    min: -59,
    max: -20,
    label: { zh: "冷淡", en: "Cold" },
    color: "blue",
  },
  {
    id: "neutral",
    min: -19,
    max: 19,
    label: { zh: "中立", en: "Neutral" },
    color: "amber",
  },
  {
    id: "friendly",
    min: 20,
    max: 59,
    label: { zh: "友好", en: "Friendly" },
    color: "green",
  },
  {
    id: "close",
    min: 60,
    max: 84,
    label: { zh: "亲密", en: "Close" },
    color: "cyan",
  },
  {
    id: "devoted",
    min: 85,
    max: 100,
    label: { zh: "挚爱", en: "Devoted" },
    color: "purple",
  },
];

/**
 * @param {number} score
 * @returns {number} score clamped to [-100, 100]
 */
export function clampScore(score) {
  return Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, score));
}

/**
 * @param {number} score
 * @returns {{ id: string, min: number, max: number, label: { zh: string, en: string }, color: string }}
 */
export function getTier(score) {
  const clamped = clampScore(score);
  return (
    AFFINITY_TIERS.find((tier) => clamped >= tier.min && clamped <= tier.max) ??
    // Unreachable after clamping — kept as a safe fallback for NaN input.
    AFFINITY_TIERS[2]
  );
}
