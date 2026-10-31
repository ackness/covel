import {
  characterNameKey,
  ToolError,
  turnPolicyModelInputSchema,
  turnPolicyModelOutputSchema,
  turnPolicyOutputSchema,
  type WorldModelView,
} from "@covel/shared";

/** Name-only resolution deliberately excludes resolveCharacter's exact-ID path. */
export function characterByName(
  world: Pick<WorldModelView, "characters"> | undefined,
  name: string,
) {
  const key = characterNameKey(name);
  const candidates = (world?.characters ?? []).filter((character) =>
    [character.name, ...(character.aliases ?? [])].some(
      (value) => characterNameKey(value) === key,
    ),
  );
  if (candidates.length !== 1)
    throw new ToolError(
      candidates.length ? "ambiguous" : "not-found",
      candidates.length
        ? "The character name is ambiguous; use a unique name or alias"
        : "No character has that name; use a name or alias from the scene",
    );
  return candidates[0]!;
}

export function policyModelRequest(
  value: unknown,
  world: WorldModelView | undefined,
  actions: readonly import("@covel/shared").TurnAction[],
) {
  const input = turnPolicyModelInputSchema.parse(value);
  return {
    actions,
    recentSegments: input.recentSegments,
    present: input.present.map((name) => {
      const character = characterByName(world, name);
      return { characterId: character.id, name: character.name };
    }),
  };
}

export function policyModelResult(
  value: unknown,
  present: readonly { characterId: string; name: string }[],
) {
  const plan = turnPolicyOutputSchema.parse(value);
  return turnPolicyModelOutputSchema.parse({
    ...plan,
    actors: plan.actors.map(({ characterId, ...actor }) => ({
      ...actor,
      character: present.find(
        (candidate) => candidate.characterId === characterId,
      )?.name,
    })),
  });
}
