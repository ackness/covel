import { characterNameKey, translate } from "@covel/plugin-handlers-utils";

/** The field of the character form that holds the player's name. */
export const NAME_FIELD = "characterName";
/** The form validator that refuses a name a character of the world has. */
export const PLAYER_NAME_VALIDATOR = "player-name";

/**
 * Every name and alias of the world's characters, as name keys. The player
 * may take none of them: the World Model refuses a name that is an alias of
 * another character, and a player who shares an NPC's full name makes every
 * later lookup of that name ambiguous.
 * @param {readonly { type?: string, name: string, aliases?: readonly string[] }[] | undefined} characters
 * @returns {string[]}
 */
export function takenNameKeys(characters) {
  const keys = new Set();
  for (const character of characters ?? []) {
    if (character.type === "player") continue;
    for (const name of [character.name, ...(character.aliases ?? [])]) {
      const key = characterNameKey(name);
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

/**
 * @param {readonly unknown[]} keys
 * @param {unknown} name
 */
export function isNameTaken(keys, name) {
  return typeof name === "string" && keys.includes(characterNameKey(name));
}

/**
 * The sentence the player reads when the name is taken.
 * @param {Parameters<typeof translate>[0]} context
 * @param {string} name
 */
export function nameTakenMessage(context, name) {
  return translate(
    context,
    'The name "{name}" already belongs to a character of this world. Choose another name.',
    { name: name.trim() },
  );
}

/**
 * Refuses the character form while its name is one the world's characters
 * have. `data.taken` holds their name keys from when the form was made.
 * @type {import("@covel/plugin-handlers-utils").PluginFormValidator}
 */
export function validatePlayerName(values, data, context) {
  const taken =
    data && typeof data === "object" && !Array.isArray(data)
      ? /** @type {{ taken?: unknown }} */ (data).taken
      : undefined;
  const name = values[NAME_FIELD];
  if (!Array.isArray(taken) || typeof name !== "string") return undefined;
  if (!isNameTaken(taken, name)) return undefined;
  return { field: NAME_FIELD, message: nameTakenMessage(context, name) };
}
