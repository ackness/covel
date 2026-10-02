/**
 * Session character ids are UUIDs or session-prefixed slugs, and the model
 * would repeat them in every reference it writes; output tokens set this
 * runtime's latency. The extraction input therefore names each character by
 * a short word handle (its name, lowercased and hyphenated), and
 * `submit-world-facts` maps handles back to the real ids. Both sides derive
 * the handles from the session roster, ordered by id so that a name shared
 * by two characters gets the same suffix whatever the list order.
 *
 * @template {{ id: string, name: string }} Character
 * @param {ReadonlyArray<Character>} characters
 * @returns {Map<string, Character>} handle → character
 */
export function characterHandles(characters) {
  const handles = new Map();
  const byId = [...characters].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const character of byId) {
    const base =
      String(character.name ?? "")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu)
        ?.join("-") || "character";
    let handle = base;
    for (let n = 2; handles.has(handle); n++) handle = `${base}-${n}`;
    handles.set(handle, character);
  }
  return handles;
}
