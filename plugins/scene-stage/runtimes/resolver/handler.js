import { withPendingProposals } from "@covel/plugin-handlers-utils";

import { createHash } from "node:crypto";
import {
  REGISTRY_KEY,
  SCENES_NS,
  STAGE_KEY,
  STAGE_NS,
  buildStageRecord,
  makeStageProposal,
} from "../../lib/stage-data.js";

/**
 * Resolve the current scene + time of day from a `scene.set` event and
 * publish `stage/current` for the visual stage. A location that matches the
 * world scene registry uses its art; any other location has no backdrop and
 * the stage falls back to the world image.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 */
export default async function handler(ctx) {
  const evt = ctx.triggerEvent;
  const location =
    typeof evt?.data?.location === "string" ? evt.data.location.trim() : "";
  if (!evt || evt.topic !== "scene.set" || !location) {
    return {
      outcome: "success",
      value: { skipped: true, reason: "no usable scene.set payload" },
    };
  }
  const variant = evt.data.timeOfDay === "night" ? "night" : "day";

  const [registry, previous] = ctx.pluginData
    ? await Promise.all([
        ctx.pluginData.get(SCENES_NS, REGISTRY_KEY),
        ctx.pluginData.get(STAGE_NS, STAGE_KEY),
      ])
    : [null, null];

  const scenes = Array.isArray(registry?.scenes) ? registry.scenes : [];
  const worldMatch = matchScene(scenes, location);
  const candidate = worldMatch
    ? {
        sceneId: String(worldMatch.sceneId),
        name: typeof worldMatch.name === "string" ? worldMatch.name : location,
        source: "world",
        day: worldMatch.day ?? null,
        night: worldMatch.night ?? null,
      }
    : {
        sceneId: sceneIdForLocation(location),
        name: location,
        source: "none",
        day: null,
        night: null,
      };

  const stage = buildStageRecord(ctx, {
    sceneId: candidate.sceneId,
    name: candidate.name,
    variant,
    source: candidate.source,
    day: candidate.day,
    night: candidate.night,
    turnId: ctx.turnId,
  });

  // A repeated scene.set for the same scene, variant and source is a no-op.
  const isNoOp =
    previous &&
    typeof previous === "object" &&
    previous.sceneId === stage.sceneId &&
    previous.variant === stage.variant &&
    previous.source === stage.source;
  if (isNoOp) {
    return {
      outcome: "success",
      value: { skipped: true, reason: "no-op: scene/variant unchanged", stage },
    };
  }

  return withPendingProposals({ outcome: "success", value: { stage } }, [
    makeStageProposal(ctx, stage),
  ]);
}

/**
 * Deterministic scene id for a location that has no registry entry —
 * `loc-` + first 8 hex chars of sha256(location) — so repeated scene.set
 * events for the same unmatched location are recognised as no-ops.
 *
 * @param {string} location
 * @returns {string}
 */
function sceneIdForLocation(location) {
  return `loc-${createHash("sha256").update(location, "utf8").digest("hex").slice(0, 8)}`;
}

function normalizeLocation(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/**
 * Match a location against the world registry: exact name/locationRef
 * equality first, then bidirectional normalized substring.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} scenes
 * @param {string} location
 */
function matchScene(scenes, location) {
  const loc = normalizeLocation(location);
  if (!loc) return null;

  for (const scene of scenes) {
    if (!scene || typeof scene !== "object") continue;
    if (
      normalizeLocation(scene.name) === loc ||
      normalizeLocation(scene.locationRef) === loc
    ) {
      return scene;
    }
  }
  for (const scene of scenes) {
    if (!scene || typeof scene !== "object") continue;
    const keys = [scene.name, scene.locationRef]
      .map(normalizeLocation)
      .filter(Boolean);
    if (keys.some((key) => loc.includes(key) || key.includes(loc))) {
      return scene;
    }
  }
  return null;
}
