import { withPendingProposals } from "@covel/plugin-handlers-utils";
import {
  REGISTRY_KEY,
  SCENE_KEY,
  STATE_NS,
  TRACKS_NS,
  makeFactProposal,
} from "../../lib/soundtrack.js";

/**
 * Record the scene of a `scene.set` event as `state/scene`.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
 */
export default async function handler(ctx) {
  const skip = (reason) => ({
    outcome: "success",
    value: { skipped: true, reason },
  });
  const evt = ctx.triggerEvent;
  const name =
    typeof evt?.data?.location === "string" ? evt.data.location.trim() : "";
  if (!evt || evt.topic !== "scene.set" || !name)
    return skip("no usable scene.set payload");
  if (!ctx.pluginData) return skip("no plugin data access");

  const [registry, previous] = await Promise.all([
    ctx.pluginData.get(TRACKS_NS, REGISTRY_KEY),
    ctx.pluginData.get(STATE_NS, SCENE_KEY),
  ]);
  if (!Array.isArray(registry?.tracks) || registry.tracks.length === 0)
    return skip("the world ships no track list");
  if (previous?.name === name) return skip("no-op: scene unchanged");

  return withPendingProposals({ outcome: "success", value: { scene: name } }, [
    makeFactProposal(ctx, SCENE_KEY, { name }),
  ]);
}
