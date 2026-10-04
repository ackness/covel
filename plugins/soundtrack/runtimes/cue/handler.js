import { withPendingProposals } from "@covel/plugin-handlers-utils";
import {
  MOOD_KEY,
  REGISTRY_KEY,
  STATE_NS,
  TRACKS_NS,
  makeFactProposal,
} from "../../lib/soundtrack.js";

/**
 * Record the mood of a `music.cue` event as `state/mood`.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
 */
export default async function handler(ctx) {
  const skip = (reason) => ({
    outcome: "success",
    value: { skipped: true, reason },
  });
  const evt = ctx.triggerEvent;
  const mood = typeof evt?.data?.mood === "string" ? evt.data.mood.trim() : "";
  if (!evt || evt.topic !== "music.cue" || !mood)
    return skip("no usable music.cue payload");
  if (!ctx.pluginData) return skip("no plugin data access");

  const [registry, previous] = await Promise.all([
    ctx.pluginData.get(TRACKS_NS, REGISTRY_KEY),
    ctx.pluginData.get(STATE_NS, MOOD_KEY),
  ]);
  if (!Array.isArray(registry?.tracks) || registry.tracks.length === 0)
    return skip("the world ships no track list");
  if (previous?.mood === mood) return skip("no-op: mood unchanged");

  return withPendingProposals({ outcome: "success", value: { mood } }, [
    makeFactProposal(ctx, MOOD_KEY, { mood }),
  ]);
}
