import { withPendingProposals } from "@covel/tools";
import {
  REGISTRY_KEY,
  SCENES_NS,
  STAGE_KEY,
  STAGE_NS,
  buildStageRecord,
  makeStageProposal,
} from "../../lib/stage-data.js";

/**
 * Seed `stage/current` with the world registry's opening scene.
 *
 * The stage is driven by `scene.set`, which only the narrative LLM emits. That
 * instruction is a prompt constraint, not a guarantee — a weak model can go a
 * whole session without emitting, and `scene-stage/resolver` is event-triggered,
 * so it simply never runs and the stage stays blank. This is the deterministic
 * floor under that chain.
 *
 * Runs in `stage: setup`, before any narrative output, so it never races the
 * LLM's own `scene.set` (same-turn event fan-out has no defined order between
 * the two, and the loser would overwrite the correct scene).
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 */
export default async function handler(ctx) {
  const done = (reason) => ({
    outcome: "success",
    value: { skipped: true, reason },
    completion: "done",
  });

  if (!ctx.pluginData) return done("no plugin data access");

  // Never overwrite a stage that already exists — a resumed session or a setup
  // retry must keep whatever the narrative already established.
  const existing = await ctx.pluginData.get(STAGE_NS, STAGE_KEY);
  if (existing) return done("stage already set");

  const registry = await ctx.pluginData.get(SCENES_NS, REGISTRY_KEY);
  const scenes = Array.isArray(registry?.scenes) ? registry.scenes : [];
  // Author order is opening order; worlds that ship no scene registry (stage
  // mode off) fall through here and cost nothing.
  const opening = scenes.find(
    (scene) => scene && typeof scene === "object" && scene.sceneId,
  );
  if (!opening) return done("no scene registry");

  const stage = buildStageRecord({
    sceneId: String(opening.sceneId),
    name:
      typeof opening.name === "string" ? opening.name : String(opening.sceneId),
    variant: "day",
    source: "world",
    day: opening.day,
    night: opening.night,
    turnId: ctx.turnId,
  });

  return withPendingProposals(
    { outcome: "success", value: { stage }, completion: "done" },
    [makeStageProposal(ctx, stage)],
  );
}
