import { withPendingProposals } from "@covel/plugin-handlers-utils";
import { castFromPresence } from "../../lib/cast-from-presence.js";
import { sceneChange, makeDirectionProposal } from "../../lib/scene-change.js";
import {
  REGISTRY_KEY,
  SCENES_NS,
  STAGE_KEY,
  STAGE_NS,
} from "../../lib/stage-data.js";

/** @type {import('@covel/plugin-handlers-utils').PluginFunctionHandler} */
export default async function handler(ctx) {
  const skip = (reason) => ({
    outcome: "success",
    value: { skipped: true, reason },
  });
  const story = ctx.inputs?.story?.value;
  const cues = story?.cues;
  const location = typeof cues?.scene === "string" ? cues.scene.trim() : "";
  const present = Array.isArray(cues?.present) ? cues.present : [];
  if (!location && !present.length)
    return skip("no story scene or presence cues");
  if (!ctx.pluginData) return skip("no plugin data access");

  const [registry, previous, direction] = await Promise.all([
    ctx.pluginData.get(SCENES_NS, REGISTRY_KEY),
    ctx.pluginData.get(STAGE_NS, STAGE_KEY),
    ctx.pluginData.get("direction", "current"),
  ]);
  const change = location
    ? sceneChange(ctx, {
        registry,
        previous,
        direction,
        location,
        variant: previous?.variant === "night" ? "night" : "day",
      })
    : null;
  let proposals = change?.sceneChanged ? change.proposals : [];
  const value = {};
  if (change?.sceneChanged) value.stage = change.stage;
  if (present.length) {
    const cast = castFromPresence(
      ctx,
      change?.sceneChanged ? null : direction,
      present,
      story.segments,
    );
    // Presence replaces the scene reset, so there is only one direction write.
    proposals = proposals.filter(
      ({ payload }) => payload.namespace !== "direction",
    );
    proposals.push(makeDirectionProposal(ctx, cast.direction));
    Object.assign(value, cast);
  }
  if (!proposals.length) return skip("no-op: scene unchanged");
  return withPendingProposals({ outcome: "success", value }, proposals);
}
