import {
  modelFacingJson,
  ToolError,
  turnPolicyModelOutputSchema,
  validateTurnPolicyOutput,
} from "@covel/plugin-handlers-utils";
import { createPromptLoader } from "@covel/plugin-handlers-utils/prompts";
import { fileURLToPath } from "node:url";
import { resolveName } from "./manual-selection.js";

const loadPrompt = createPromptLoader(
  fileURLToPath(new URL("..", import.meta.url)),
);

export async function director(input, ctx) {
  let slot;
  try {
    slot = ctx.gateway?.resolveSlot({});
  } catch {
    ctx.signal.throwIfAborted();
  }
  if (!ctx.gateway || !slot)
    throw new ToolError("unavailable", "The director model is unavailable.");
  ctx.signal.throwIfAborted();
  const system = await loadPrompt("prompts", "director", ctx.locale);
  const view = {
    language: ctx.locale,
    actions: input.actions.map((action) => ({
      kind: action.kind.includes("/") ? "selection" : action.kind,
      source: action.source,
      ...(action.text ? { text: action.text } : {}),
    })),
    present: input.present.map(({ name }) => name),
    recentSegments: input.recentSegments.map(({ kind, speaker, text }) => ({
      kind,
      ...(speaker ? { speaker } : {}),
      text,
    })),
    limits: input.limits,
  };
  const response = await ctx.gateway.generateObject({
    schema: turnPolicyModelOutputSchema.toJSONSchema({ target: "draft-7" }),
    system,
    prompt: JSON.stringify(modelFacingJson(view)),
    signal: ctx.signal,
    maxOutputTokens: 2_000,
  });
  ctx.signal.throwIfAborted();
  const plan = turnPolicyModelOutputSchema.parse(response.object);
  let actors;
  try {
    actors = plan.actors.map(({ character, ...rest }) => ({
      characterId: resolveName(ctx.world.characters, character).id,
      ...rest,
    }));
  } catch {
    ctx.signal.throwIfAborted();
    throw new Error("The director returned an invalid cast.");
  }
  const result = validateTurnPolicyOutput(input, { ...plan, actors });
  return {
    ...result,
    actors: result.actors.slice(
      0,
      Math.min(input.limits.maxActors, input.limits.maxSubagentCalls),
    ),
  };
}
