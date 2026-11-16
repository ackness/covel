// @ts-check
import {
  characterNameKey,
  resolveCharacter,
} from "@covel/plugin-handlers-utils";
import { AFFINITY_TIERS, getTier, tierLabel } from "../tier-metadata.js";
import { committedScores } from "./current-affinity.js";

/** The tier ids from the lowest to the highest; consumers compare by order. */
export const TIER_ORDER = AFFINITY_TIERS.map((tier) => tier.id);

/**
 * `affinity.tier@1`: the committed affinity of each NPC with its tier, so
 * that another plugin can gate a rule on how an NPC feels about the player.
 * `name` narrows the answer to one character, matched like the writer
 * matches it (canonical name or a known alias).
 *
 * @param {{ name?: string }} input
 * @param {import("@covel/plugin-handlers-utils").PluginServiceContext} ctx
 */
export async function affinityTiers({ name }, ctx) {
  let scores = await committedScores(ctx);
  if (name?.trim()) {
    const resolved = resolveCharacter(ctx.world?.characters ?? [], name);
    const key = characterNameKey(
      resolved.status === "found" ? resolved.character.name : name,
    );
    scores = scores.filter(
      (score) => characterNameKey(score.canonicalName) === key,
    );
  }
  return {
    tiers: TIER_ORDER,
    characters: scores.map(({ canonicalName, score }) => {
      const tier = getTier(score).id;
      return { name: canonicalName, score, tier, label: tierLabel(ctx, tier) };
    }),
  };
}
