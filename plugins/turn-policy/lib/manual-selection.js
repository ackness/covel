import {
  resolveCharacter,
  STORY_LIMITS,
  ToolError,
} from "@covel/plugin-handlers-utils";

export const INVALID_SELECTION =
  "Choose present actors by exact name or alias, one per line; at most 32 names.";

export function nameLines(value) {
  if (
    typeof value !== "string" ||
    value.length > 32 * (STORY_LIMITS.speaker + 2)
  )
    throw new ToolError("invalid-input", INVALID_SELECTION);
  const names = value
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter(Boolean);
  if (
    names.length > 32 ||
    names.some((name) => name.length > STORY_LIMITS.speaker)
  )
    throw new ToolError("invalid-input", INVALID_SELECTION);
  return names;
}

export function resolveName(characters, name) {
  const result = resolveCharacter(characters, name);
  if (result.status !== "found" || result.matchedBy === "id")
    throw new ToolError("invalid-input", INVALID_SELECTION);
  return result.character;
}

export function manualSelection(actions, characters, present, pluginId) {
  try {
    return parseSelection(actions, characters, present, pluginId);
  } catch (error) {
    if (error?.code !== "invalid-input") throw error;
    throw new ToolError("invalid-input", INVALID_SELECTION, {
      hint: "invalid-selection",
    });
  }
}

function parseSelection(actions, characters, present, pluginId) {
  const selections = actions.filter(
    (action) =>
      action.source === "player" && action.kind === `${pluginId}/choose-actors`,
  );
  const names = selections.flatMap((action) => {
    if (
      !action.fields ||
      Object.keys(action.fields).some((key) => key !== "actors")
    )
      throw new ToolError("invalid-input", INVALID_SELECTION);
    const lines = nameLines(action.fields.actors);
    if (!lines.length) throw new ToolError("invalid-input", INVALID_SELECTION);
    return lines.map((name) => ({
      name,
      instruction: action.text?.slice(0, 2_000),
    }));
  });
  if (names.length > 32)
    throw new ToolError("invalid-input", INVALID_SELECTION);
  const eligible = new Set(present.map((actor) => actor.characterId));
  const seen = new Set();
  return names.flatMap(({ name, instruction }) => {
    const character = resolveName(characters, name);
    if (!eligible.has(character.id))
      throw new ToolError("invalid-input", INVALID_SELECTION);
    if (seen.has(character.id)) return [];
    seen.add(character.id);
    return [
      { characterId: character.id, ...(instruction ? { instruction } : {}) },
    ];
  });
}
