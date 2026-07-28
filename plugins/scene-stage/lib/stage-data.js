/**
 * Shared plugin_data namespace/key constants and small pure helpers used by
 * the scene-stage runtimes (resolver + background-gen + seed). Kept in one
 * place so the handlers can't drift on namespace names, on the source→label
 * mapping, or on the `stage/current` record shape the right-panel spec
 * (`ui/scene-stage-panel.json`) and the stage view depend on.
 */

import { makeProposal } from "@covel/plugin-handlers-utils";

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

/**
 * Build the `stage/current` record. The single writer-side definition of the
 * shape — every runtime that publishes a stage goes through here so a new
 * field can't reach the panel from one handler and not the other.
 *
 * @param {{
 *   sceneId: string,
 *   name: string,
 *   variant: "day"|"night",
 *   source: string,
 *   day?: unknown,
 *   night?: unknown,
 *   turnId?: string,
 * }} params
 */
export function buildStageRecord(params) {
  const day = params.day ?? null;
  const night = params.night ?? null;
  return {
    sceneId: params.sceneId,
    name: params.name,
    variant: params.variant,
    variantLabel: variantLabelFor(params.variant),
    source: params.source,
    day,
    night,
    resolved: resolveMedia(params.variant, day, night),
    sourceLabel: sourceLabelFor(params.source),
    turnId: params.turnId,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Wrap a stage record in the `plugin.data` proposal that publishes it.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @param {ReturnType<typeof buildStageRecord>} stage
 */
export function makeStageProposal(ctx, stage) {
  return makeProposal(ctx, new Date().toISOString(), "plugin.data", {
    namespace: STAGE_NS,
    key: STAGE_KEY,
    value: stage,
  });
}
