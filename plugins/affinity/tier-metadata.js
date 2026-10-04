/**
 * Affinity tier metadata (plugin-local).
 *
 * Single source of truth for the score range, the six tier bands, and the
 * per-tier display metadata (name + Badge color). The tool derives `tier` /
 * `tierLabel` / `tierColor` from the cumulative score on every write, with
 * the name in the session's language (`locales/` translates it), so the UI (json-render spec) renders tier badges without any
 * framework-side lookup table — same pattern as codex's category-metadata.js.
 */

import { translate } from "@covel/plugin-handlers-utils";

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
    color: "red",
  },
  {
    id: "cold",
    min: -59,
    max: -20,
    color: "blue",
  },
  {
    id: "neutral",
    min: -19,
    max: 19,
    color: "amber",
  },
  {
    id: "friendly",
    min: 20,
    max: 59,
    color: "green",
  },
  {
    id: "close",
    min: 60,
    max: 84,
    color: "cyan",
  },
  {
    id: "devoted",
    min: 85,
    max: 100,
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
 * @returns {{ id: string, min: number, max: number, color: string }}
 */
export function getTier(score) {
  const clamped = clampScore(score);
  return (
    AFFINITY_TIERS.find((tier) => clamped >= tier.min && clamped <= tier.max) ??
    // Unreachable after clamping — kept as a safe fallback for NaN input.
    AFFINITY_TIERS[2]
  );
}

/**
 * The tier's name in the session's language. The record that holds it is
 * injected into this plugin's prompt, so it is one language, not a pair.
 *
 * @param {import("@covel/plugin-handlers-utils").PluginMessageContext | undefined} ctx
 * @param {string} tierId
 * @returns {string}
 */
export function tierLabel(ctx, tierId) {
  // Each text is a literal: the validator reads them from the source.
  const labels = {
    hostile: translate(ctx, "Hostile"),
    cold: translate(ctx, "Cold"),
    neutral: translate(ctx, "Neutral"),
    friendly: translate(ctx, "Friendly"),
    close: translate(ctx, "Close"),
    devoted: translate(ctx, "Devoted"),
  };
  return labels[tierId] ?? tierId;
}
