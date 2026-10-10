/**
 * One rule for turning a name into a character of the World Model.
 *
 * A story calls one person many things: a name, a nickname, a title, the
 * same name in another script. A character therefore has `aliases` next to
 * its `name`, and every lookup by name goes through `resolveCharacter`, so
 * that the builtin tools and every plugin agree on who a name means.
 */

/** The part of a character a lookup reads. */
export interface NamedCharacter {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
}

const NAME_DOTS = /[·・‧•∙⋅]/g;
const APOSTROPHES = /[‘’ʼ｀`]/g;
const SURROUNDING = /^[\s"'“”「」『』《》〈〉]+|[\s"'“”「」『』《》〈〉]+$/g;

/**
 * The form two spellings of one name share. Folded: letter case, full-width
 * and half-width forms (NFKC), the amount of white space, quotation marks
 * around the name, the middle dot between the parts of a transliterated name
 * (`・` `·` `•`), the kind of apostrophe, and a leading English "the".
 *
 * Not folded: titles, honorifics and particles ("Dr.", "Sister", "先生",
 * "老"). "Mr. Park" and "Dr. Park", or "陈先生" and "陈小姐", can be two
 * people; a title that names one person is declared as an alias.
 */
export function characterNameKey(text: string): string {
  return text
    .normalize("NFKC")
    .replace(NAME_DOTS, "·")
    .replace(APOSTROPHES, "'")
    .replace(SURROUNDING, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/^the /, "");
}

export type CharacterResolution<C extends NamedCharacter> =
  | {
      readonly status: "found";
      readonly character: C;
      readonly matchedBy: "id" | "name" | "alias" | "partial";
    }
  /** The name or alias belongs to more than one character. */
  | { readonly status: "ambiguous"; readonly candidates: readonly C[] }
  /** No character has it; `closest` holds the similar ones, best first. */
  | { readonly status: "missing"; readonly closest: readonly C[] };

const namesOf = (character: NamedCharacter): string[] => [
  character.name,
  ...(character.aliases ?? []),
];

const unique = <C extends NamedCharacter>(characters: readonly C[]): C[] => [
  ...new Map(characters.map((character) => [character.id, character])).values(),
];

function bigrams(key: string): Set<string> {
  const units = [...key.replace(/ /g, "")];
  if (units.length < 2) return new Set(units);
  return new Set(units.slice(0, -1).map((unit, i) => unit + units[i + 1]!));
}

/** 1 when one key contains the other, otherwise the Dice overlap of pairs. */
function similarity(a: string, b: string): number {
  if (a.includes(b) || b.includes(a)) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const pair of left) if (right.has(pair)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

const CLOSE_ENOUGH = 0.34;
const MAX_CLOSEST = 5;

/**
 * Who `query` means among `characters`: the character with that exact ID,
 * else the one with that name, else the one with that alias, names compared
 * by `characterNameKey`. A name or alias that two characters have is
 * `ambiguous`, never one of them.
 *
 * `partial` is for reads only: when nothing matches exactly, the single
 * character whose name or alias contains the query, or is contained in it,
 * is returned ("Mina Park" finds "Dr. Mina Park"). A write must not use it:
 * "陈" would reach 陈远山 until a second 陈 enters the story.
 *
 * On `missing`, `closest` lists the characters whose names are similar, for
 * a message that lets a model correct the name. Similarity never resolves.
 */
export function resolveCharacter<C extends NamedCharacter>(
  characters: readonly C[],
  query: string,
  options: { readonly partial?: boolean } = {},
): CharacterResolution<C> {
  const byId = characters.find((character) => character.id === query);
  if (byId) return { status: "found", character: byId, matchedBy: "id" };

  const key = characterNameKey(query);
  if (!key) return { status: "missing", closest: [] };

  const named = characters.filter(
    (character) => characterNameKey(character.name) === key,
  );
  if (named.length === 1)
    return { status: "found", character: named[0]!, matchedBy: "name" };
  if (named.length > 1) return { status: "ambiguous", candidates: named };

  const aliased = characters.filter((character) =>
    (character.aliases ?? []).some((alias) => characterNameKey(alias) === key),
  );
  if (aliased.length === 1)
    return { status: "found", character: aliased[0]!, matchedBy: "alias" };
  if (aliased.length > 1) return { status: "ambiguous", candidates: aliased };

  const scored = characters
    .map((character) => ({
      character,
      score: Math.max(
        0,
        ...namesOf(character)
          .map(characterNameKey)
          .filter(Boolean)
          .map((name) => similarity(name, key)),
      ),
    }))
    .filter((entry) => entry.score >= CLOSE_ENOUGH)
    .sort((a, b) => b.score - a.score);

  if (options.partial) {
    const containing = unique(
      scored.filter((entry) => entry.score === 1).map((e) => e.character),
    );
    if (containing.length === 1)
      return {
        status: "found",
        character: containing[0]!,
        matchedBy: "partial",
      };
    if (containing.length > 1)
      return { status: "missing", closest: containing };
  }
  return {
    status: "missing",
    closest: scored.slice(0, MAX_CLOSEST).map((entry) => entry.character),
  };
}

/** `Isolde (aka the keeper, 伊索德)`: a character as a model reads it. */
export function characterLabel(character: {
  readonly name: string;
  readonly aliases?: readonly string[];
}): string {
  return character.aliases?.length
    ? `${character.name} (aka ${character.aliases.join(", ")})`
    : character.name;
}

/**
 * `current` followed by the names of `added` the character does not have
 * yet. A name equal to the character's own name, or to an alias it has, is
 * left out: by `characterNameKey` it is the same name.
 */
export function mergeCharacterAliases(
  name: string,
  current: readonly string[] | undefined,
  added: readonly string[] | undefined,
): string[] {
  const seen = new Set([characterNameKey(name)]);
  const merged: string[] = [];
  for (const alias of [...(current ?? []), ...(added ?? [])]) {
    const text = alias.trim().replace(/\s+/g, " ");
    const key = characterNameKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(text);
  }
  return merged;
}

/**
 * The first alias of `character` that is already a name or an alias of
 * another character, with that character. One name must mean one person.
 */
export function findCharacterAliasConflict<C extends NamedCharacter>(
  characters: readonly C[],
  character: NamedCharacter,
): { readonly alias: string; readonly owner: C } | undefined {
  for (const alias of character.aliases ?? []) {
    const key = characterNameKey(alias);
    const owner = characters.find(
      (other) =>
        other.id !== character.id &&
        namesOf(other).some((name) => characterNameKey(name) === key),
    );
    if (owner) return { alias, owner };
  }
  return undefined;
}

const MAX_KNOWN_NAMES = 30;

/**
 * What a tool tells a model when `resolveCharacter` did not find one
 * character: the candidates of an ambiguous name, or the closest known
 * names, so that the next call names an existing character. Tool feedback
 * is English.
 */
export function describeUnresolvedCharacter<C extends NamedCharacter>(
  query: string,
  resolution: Exclude<CharacterResolution<C>, { status: "found" }>,
  characters: readonly C[],
): string {
  if (resolution.status === "ambiguous")
    return `"${query}" names ${resolution.candidates.length} characters: ${resolution.candidates
      .map((character) => `${characterLabel(character)} [${character.id}]`)
      .join("; ")}. Pass the id of the one you mean.`;
  if (resolution.closest.length > 0)
    return `Character "${query}" not found. Closest known names: ${resolution.closest
      .map(characterLabel)
      .join("; ")}. If it is one of them, use that name.`;
  const known = characters.slice(0, MAX_KNOWN_NAMES).map(characterLabel);
  return known.length > 0
    ? `Character "${query}" not found. Characters in session: ${known.join("; ")}.`
    : `Character "${query}" not found. The session has no characters yet.`;
}
