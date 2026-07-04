/**
 * Shared plugin_data namespace/key constants and small pure helpers used by
 * both scene-stage runtimes (resolver + background-gen). Kept in one place
 * so the two handlers can't drift on namespace names or the source→label
 * mapping the right-panel spec (`ui/scene-stage-panel.json`) depends on.
 */

export const SCENES_NS = "scenes";
export const REGISTRY_KEY = "scene-registry";
export const STAGE_NS = "stage";
export const STAGE_KEY = "current";
export const GENERATED_NS = "generated";
export const GENERATE_REQUESTED_TOPIC = "scene-stage.generate.requested";

/** @type {Record<string, {zh: string, en: string}>} */
const SOURCE_LABELS = {
  world: { zh: "世界背景", en: "World art" },
  session: { zh: "本局生成", en: "Generated this session" },
  pending: { zh: "背景生成中…", en: "Generating…" },
  none: { zh: "无背景", en: "No backdrop" },
};

/**
 * @param {string} source
 * @returns {{zh: string, en: string}}
 */
export function sourceLabelFor(source) {
  return SOURCE_LABELS[source] ?? SOURCE_LABELS.none;
}

/** @type {Record<"day"|"night", {zh: string, en: string}>} */
const VARIANT_LABELS = {
  day: { zh: "白天", en: "Day" },
  night: { zh: "夜晚", en: "Night" },
};

/**
 * @param {"day"|"night"} variant
 * @returns {{zh: string, en: string}}
 */
export function variantLabelFor(variant) {
  return VARIANT_LABELS[variant] ?? VARIANT_LABELS.day;
}

/**
 * Pick the display MediaRef for a variant, falling back night → day when
 * the night image hasn't been generated yet (A §4 fallback chain).
 *
 * @param {"day"|"night"} variant
 * @param {unknown} day
 * @param {unknown} night
 * @returns {unknown}
 */
export function resolveMedia(variant, day, night) {
  if (variant === "night") return night ?? day ?? null;
  return day ?? null;
}
