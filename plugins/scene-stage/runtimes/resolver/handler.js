import { withPendingProposals } from "@covel/plugin-handlers-utils";

import {
  REGISTRY_KEY,
  SCENES_NS,
  STAGE_KEY,
  STAGE_NS,
} from "../../lib/stage-data.js";
import { sceneChange } from "../../lib/scene-change.js";

/**
 * Resolve the current scene + time of day from a `scene.set` event and
 * publish `stage/current` for the visual stage. A location that matches the
 * world scene registry uses its art; any other location has no backdrop and
 * the stage falls back to the world image.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
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

  const [registry, previous, direction] = ctx.pluginData
    ? await Promise.all([
        ctx.pluginData.get(SCENES_NS, REGISTRY_KEY),
        ctx.pluginData.get(STAGE_NS, STAGE_KEY),
        ctx.pluginData.get("direction", "current"),
      ])
    : [null, null, null];

  const { stage, changed, proposals } = sceneChange(ctx, {
    registry,
    previous,
    direction,
    location,
    variant,
  });
  if (!changed) {
    return {
      outcome: "success",
      value: { skipped: true, reason: "no-op: scene/variant unchanged", stage },
    };
  }

  return withPendingProposals(
    { outcome: "success", value: { stage } },
    proposals,
  );
}
