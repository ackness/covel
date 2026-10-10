import { createHash } from "node:crypto";
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

/** @param {string} salt @param {string} key */
function nameDigest(salt, key) {
  return createHash("sha256")
    .update(`${salt}\n${key}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * What the form's validator compares a submitted name with. The form block,
 * its `validation.data` included, is sent to the player's client and kept in
 * the session's messages, and the cast has names the story reveals later:
 * the names themselves must not be in it. Each name key is stored as a
 * digest salted for this form, in sorted order, so the list cannot be read
 * and says nothing about which character a digest belongs to. It is not
 * proof against guessing: whoever has the salt can test a name they already
 * suspect, which is what submitting the form tells them too.
 * @param {Parameters<typeof takenNameKeys>[0]} characters
 * @param {string} salt
 * @returns {{ salt: string, taken: string[] }}
 */
export function takenNameDigests(characters, salt) {
  return {
    salt,
    taken: takenNameKeys(characters)
      .map((key) => nameDigest(salt, key))
      .sort(),
  };
}

/**
 * Refuses the character form while its name is one the world's characters
 * had when the form was made: `data` is what `takenNameDigests` returned.
 * @type {import("@covel/plugin-handlers-utils").PluginFormValidator}
 */
export function validatePlayerName(values, data, context) {
  const { salt, taken } =
    data && typeof data === "object" && !Array.isArray(data)
      ? /** @type {{ salt?: unknown, taken?: unknown }} */ (data)
      : {};
  const name = values[NAME_FIELD];
  if (
    typeof salt !== "string" ||
    !Array.isArray(taken) ||
    typeof name !== "string" ||
    !taken.includes(nameDigest(salt, characterNameKey(name)))
  )
    return undefined;
  return { field: NAME_FIELD, message: nameTakenMessage(context, name) };
}
