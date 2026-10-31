import { withPendingProposals } from "@covel/plugin-handlers-utils";
import {
  MOOD_KEY,
  REGISTRY_KEY,
  SCENE_KEY,
  STATE_NS,
  TRACKS_NS,
  makeFactProposal,
  matchMood,
} from "../../lib/soundtrack.js";

/** @type {import('@covel/plugin-handlers-utils').PluginFunctionHandler} */
export default async function handler(ctx) {
  const skip = (reason) => ({
    outcome: "success",
    value: { skipped: true, reason },
  });
  const cues = ctx.inputs?.story?.value?.cues;
  const mood = typeof cues?.mood === "string" ? cues.mood.trim() : "";
  const scene = typeof cues?.scene === "string" ? cues.scene.trim() : "";
  if (!mood && !scene) return skip("no story mood or scene cues");
  if (!ctx.pluginData) return skip("no plugin data access");

  const [registry, previousMood, previousScene] = await Promise.all([
    ctx.pluginData.get(TRACKS_NS, REGISTRY_KEY),
    ctx.pluginData.get(STATE_NS, MOOD_KEY),
    ctx.pluginData.get(STATE_NS, SCENE_KEY),
  ]);
  if (!Array.isArray(registry?.tracks) || registry.tracks.length === 0)
    return skip("the world ships no track list");

  const proposals = [];
  const reasons = [];
  const value = {};
  if (mood) {
    const matched = matchMood(registry, mood);
    if (!matched) reasons.push("mood not in this world's list");
    else if (previousMood?.mood === matched)
      reasons.push("no-op: mood unchanged");
    else {
      proposals.push(makeFactProposal(ctx, MOOD_KEY, { mood: matched }));
      value.mood = matched;
    }
  }
  if (scene) {
    if (previousScene?.name === scene) reasons.push("no-op: scene unchanged");
    else {
      proposals.push(makeFactProposal(ctx, SCENE_KEY, { name: scene }));
      value.scene = scene;
    }
  }
  if (!proposals.length) return skip(reasons.join("; "));
  return withPendingProposals(
    { outcome: "success", value: { ...value, reasons } },
    proposals,
  );
}
