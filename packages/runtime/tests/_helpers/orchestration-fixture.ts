import {
  TURN_POLICY_CONTRACT,
  CHARACTER_ACTOR_CONTRACT,
  turnPolicyInputSchema,
  turnPolicyOutputSchema,
  characterActorOutputSchema,
  ToolError,
  type HandlerResult,
  type PluginAPI,
  type PluginFunctionContext,
  type PluginReadServiceDefinition,
  type TurnPolicyInput,
  type TurnPolicyOutput,
  type StorySegment,
} from "@covel/plugin-handlers-utils";

export const policies: readonly PluginReadServiceDefinition<
  TurnPolicyInput,
  TurnPolicyOutput
>[] = [
  {
    name: "ensemble",
    contract: TURN_POLICY_CONTRACT,
    modelFacing: true,
    description: "Invite the present characters to contribute in parallel",
    input: turnPolicyInputSchema,
    output: turnPolicyOutputSchema,
    handler: (input) => ({
      actors: input.present.map(({ characterId }) => ({ characterId })),
      order: "parallel",
      narrator: "after",
      yieldHint: "user",
    }),
  },
  {
    name: "draw",
    contract: TURN_POLICY_CONTRACT,
    modelFacing: true,
    description:
      "Invite one present character using the provider's random stream",
    input: turnPolicyInputSchema,
    output: turnPolicyOutputSchema,
    handler: (input, ctx) => ({
      actors: input.present.length
        ? [
            {
              characterId:
                input.present[ctx.random.int(0, input.present.length)]!
                  .characterId,
            },
          ]
        : [],
      order: "sequential",
      narrator: "after",
      yieldHint: "user",
    }),
  },
];

/** A director must respect the caller path's existing gateway availability. */
export const directorPolicy: PluginReadServiceDefinition<
  TurnPolicyInput,
  TurnPolicyOutput
> = {
  name: "director",
  contract: TURN_POLICY_CONTRACT,
  modelFacing: true,
  description: "Prove that code callers may lend a gateway to a director",
  input: turnPolicyInputSchema,
  output: turnPolicyOutputSchema,
  handler: (input, ctx) => {
    if (!ctx.gateway)
      throw new ToolError(
        "unavailable",
        "The director needs a model gateway; continue without a plan",
      );
    // No model request is needed to exercise the public capability boundary.
    return {
      actors: input.present
        .slice(0, 1)
        .map(({ characterId }) => ({ characterId })),
      order: "sequential",
      narrator: "after",
      yieldHint: "user",
    };
  },
};

export default function register(api: PluginAPI) {
  for (const policy of policies) api.registerService(policy);
}

/** One story, with contributions kept in policy order regardless of arrival. */
export async function composeStory(
  ctx: PluginFunctionContext,
): Promise<HandlerResult> {
  const present = (ctx.world?.characters ?? []).map(({ id, name }) => ({
    characterId: id,
    name,
  }));
  const fallback = {
    kind: "narration" as const,
    text: "The room grows quiet as the conversation continues.",
  };
  let plan: TurnPolicyOutput;
  try {
    plan = turnPolicyOutputSchema.parse(
      await ctx.services?.call({
        contract: TURN_POLICY_CONTRACT,
        input: { actions: ctx.playerActions, present, recentSegments: [] },
      }),
    );
  } catch {
    ctx.signal?.throwIfAborted();
    return { outcome: "success" as const, value: { segments: [fallback] } };
  }
  const run = async (
    actor: TurnPolicyOutput["actors"][number],
  ): Promise<StorySegment[]> => {
    const result = await ctx.agents?.run({
      target: { contract: CHARACTER_ACTOR_CONTRACT },
      characterId: actor.characterId,
      brief: "Respond to the conversation in the room.",
      instruction: actor.instruction,
    });
    ctx.signal?.throwIfAborted();
    if (!result?.ok) return [];
    const answer = characterActorOutputSchema.parse(result.output);
    const speaker = present.find(
      (person) => person.characterId === actor.characterId,
    )?.name;
    return answer.segments.map((segment) => ({ ...segment, speaker }));
  };
  const replies: StorySegment[][] = [];
  if (plan.order === "parallel")
    replies.push(...(await Promise.all(plan.actors.map(run))));
  else for (const actor of plan.actors) replies.push(await run(actor));
  const segments = replies.flat();
  if (plan.narrator === "before") segments.unshift(fallback);
  if (plan.narrator === "after" || segments.length === 0)
    segments.push(fallback);
  return {
    outcome: "success",
    value: {
      segments: segments.map(({ kind, text, speaker }) => ({
        kind,
        text,
        ...(speaker ? { speaker } : {}),
      })),
      yield: "user",
    },
  };
}
