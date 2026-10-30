import { makeProposal } from "@covel/plugin-handlers-utils";
import { matchScene } from "./scene-match.js";
import {
  buildStageRecord,
  makeStageProposal,
  sceneIdForLocation,
} from "./stage-data.js";

/** Build the same scene update and actor reset for story cues and events. */
export function sceneChange(
  ctx,
  { registry, previous, direction, location, variant },
) {
  const scenes = Array.isArray(registry?.scenes) ? registry.scenes : [];
  const matched = matchScene(scenes, location);
  const stage = buildStageRecord(ctx, {
    sceneId: matched ? String(matched.sceneId) : sceneIdForLocation(location),
    name: typeof matched?.name === "string" ? matched.name : location,
    source: matched ? "world" : "none",
    day: matched?.day ?? null,
    night: matched?.night ?? null,
    variant,
    turnId: ctx.turnId,
  });
  const sceneChanged = previous?.sceneId !== stage.sceneId;
  const changed =
    sceneChanged ||
    previous?.variant !== stage.variant ||
    previous?.source !== stage.source;
  const proposals = changed ? [makeStageProposal(ctx, stage)] : [];
  if (previous?.sceneId && sceneChanged && direction) {
    proposals.push(
      makeDirectionProposal(ctx, {
        schemaVersion: 1,
        actors: [],
        turnId: ctx.turnId,
        updatedAt: stage.updatedAt,
      }),
    );
  }
  return { stage, changed, sceneChanged, proposals };
}

export function makeDirectionProposal(ctx, direction) {
  return makeProposal(ctx, direction.updatedAt, "plugin.data", {
    namespace: "direction",
    key: "current",
    value: direction,
  });
}
