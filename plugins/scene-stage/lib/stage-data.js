/**
 * Shared plugin_data namespace/key constants and small pure helpers used by
 * the scene-stage runtimes (resolver + seed). Kept in one
 * place so the handlers can't drift on namespace names, on the source→label
 * mapping, or on the `stage/current` record shape the right-panel spec
 * (`ui/scene-stage-panel.json`) and the stage view depend on.
 */

import { labelText, makeProposal } from "@covel/plugin-handlers-utils";

export const SCENES_NS = "scenes";
export const REGISTRY_KEY = "scene-registry";
export const STAGE_NS = "stage";
export const STAGE_KEY = "current";

/**
 * The backdrop source's name in every language the plugin ships. Only the
 * panel and the stage draw it; they pick the player's UI language.
 *
 * @param {import('@covel/plugin-handlers-utils').PluginMessageContext | undefined} ctx
 * @param {string} source
 */
export function sourceLabelFor(ctx, source) {
  // Each text is a literal: the validator reads them from the source.
  return source === "world"
    ? labelText(ctx, "World art")
    : labelText(ctx, "No backdrop");
}

/**
 * @param {import('@covel/plugin-handlers-utils').PluginMessageContext | undefined} ctx
 * @param {"day"|"night"} variant
 */
export function variantLabelFor(ctx, variant) {
  return variant === "night" ? labelText(ctx, "Night") : labelText(ctx, "Day");
}

/**
 * Pick the display MediaRef for a variant, falling back night → day when
 * the world package has no night image.
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
 * @param {import('@covel/plugin-handlers-utils').PluginMessageContext | undefined} ctx
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
export function buildStageRecord(ctx, params) {
  const day = params.day ?? null;
  const night = params.night ?? null;
  return {
    sceneId: params.sceneId,
    name: params.name,
    variant: params.variant,
    variantLabel: variantLabelFor(ctx, params.variant),
    source: params.source,
    day,
    night,
    resolved: resolveMedia(params.variant, day, night),
    sourceLabel: sourceLabelFor(ctx, params.source),
    turnId: params.turnId,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Wrap a stage record in the `plugin.data` proposal that publishes it.
 *
 * @param {import('@covel/plugin-handlers-utils').PluginFunctionContext} ctx
 * @param {ReturnType<typeof buildStageRecord>} stage
 */
export function makeStageProposal(ctx, stage) {
  return makeProposal(ctx, new Date().toISOString(), "plugin.data", {
    namespace: STAGE_NS,
    key: STAGE_KEY,
    value: stage,
  });
}
