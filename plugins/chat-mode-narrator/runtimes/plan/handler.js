import {
  modelFacingJson,
  TURN_POLICY_CONTRACT,
  validateTurnPolicyOutput,
} from "@covel/plugin-handlers-utils";
import {
  presentCast,
  previousStory,
  observableBrief,
} from "../../lib/present-cast.js";
import { policyPlanSchema } from "../../lib/policy-plan.js";

/** @type {import('@covel/plugin-handlers-utils').PluginFunctionHandler} */
export default async function handler(ctx) {
  ctx.signal?.throwIfAborted();
  const previous = previousStory(ctx.exports?.previous?.value);
  const present = presentCast(ctx, previous);
  const fallback = {
    status: "unavailable",
    cast: present.map(({ name }) => name),
    actors: [],
    brief: observableBrief(previous, ctx.playerActions, ctx.locale),
    order: "sequential",
    narrator: "after",
    yieldHint: "user",
  };
  let result = fallback;
  try {
    if (ctx.services) {
      const request = {
        actions: ctx.playerActions,
        present,
        recentSegments: previous?.segments ?? [],
      };
      const value = await ctx.services.call(
        { contract: TURN_POLICY_CONTRACT, input: request },
        { signal: ctx.signal },
      );
      ctx.signal?.throwIfAborted();
      const plan = validateTurnPolicyOutput({ present }, value);
      result = {
        ...fallback,
        status: "available",
        ...plan,
        actors: plan.actors.map(({ characterId, reason, instruction }) => ({
          character: present.find((actor) => actor.characterId === characterId)
            .name,
          ...(reason ? { reason } : {}),
          ...(instruction ? { instruction } : {}),
        })),
      };
      if (!result.actors.length) result.yieldHint = "user";
    }
  } catch (error) {
    ctx.signal?.throwIfAborted();
    result = {
      ...fallback,
      status:
        error?.code === "invalid-input" && error?.hint === "invalid-selection"
          ? "invalid-selection"
          : "unavailable",
    };
  }
  return {
    outcome: "success",
    value: modelFacingJson(policyPlanSchema.parse(result)),
  };
}
