import { choiceRecommendationSchema } from "./recommendation-schema.js";
import { CONTRACT } from "./server.js";

const DEFAULT_GOAL =
  "Choose the action that best follows the player's latest stated intent, fits the confirmed scene, and moves the current decision forward without inventing facts.";

/** @param {import('@covel/shared/plugin-runtime').FunctionHandlerContext} ctx */
export default async function handler(ctx) {
  const choices = ctx.inputs?.choices;
  const narrative = ctx.inputs?.narrative;
  if (choices?.cardinality !== "one" || narrative?.cardinality !== "one") {
    return {
      outcome: "skipped",
      skipReason: "Current choices and narrative are required",
    };
  }
  const { scene, recap, decision, prompts } = choices.value;
  const options = prompts.map((prompt, index) => ({
    id: `prompt:${index + 1}`,
    text: prompt.text.trim(),
  }));
  const base = { turnId: ctx.turnId, source: choices.source, options };
  let recommendation = { status: "unavailable", reason: "unsupported" };
  if (ctx.services) {
    try {
      recommendation = await ctx.services.call({
        pluginId: ctx.pluginId,
        name: "recommend",
        contract: CONTRACT,
        input: {
          presetId: String(ctx.userSettings?.evaluationSlot || "evaluation"),
          goal: String(ctx.userSettings?.goal || DEFAULT_GOAL).slice(0, 2000),
          state: {
            narrative: narrative.value.slice(0, 12000),
            scene,
            recap,
            decision,
            playerIntent: ctx.playerMessage.slice(0, 2000),
          },
          options,
        },
      });
    } catch {
      ctx.signal?.throwIfAborted();
      recommendation = { status: "unavailable", reason: "failed" };
    }
  }
  const value = choiceRecommendationSchema.parse({
    ...base,
    ...recommendation,
  });
  return {
    outcome: "success",
    value,
    effects: {
      pluginData: [{ namespace: "recommendations", key: "current", value }],
    },
  };
}
