/**
 * Which characters a piece of text names, by name or alias.
 *
 * `resolveCharacter` answers "who does this one name mean"; this answers "who
 * is mentioned in this text". The rules keep a short name from matching
 * inside another word or inside a longer name of someone else.
 */

/** The part of a character or graph node a mention search reads. */
export interface MentionableCharacter {
  readonly id?: string;
  readonly name?: string;
  readonly aliases?: unknown;
}

// A letter or digit of a script that writes words with spaces between them.
// Chinese, Japanese and Korean text has no such boundary, so a name written in
// it may start or end anywhere.
const SPACED_WORD_CHARACTER =
  /^(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}]$/u;

function inWord(character: string | undefined): boolean {
  return character !== undefined && SPACED_WORD_CHARACTER.test(character);
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Where `name` is written in `text` (both lower case). A name that starts or
 * ends with a letter of a spaced script must stand as a word: "Rin" is not in
 * "spring".
 */
function occurrences(text: string, name: string): Span[] {
  const found: Span[] = [];
  const units = [...name];
  for (
    let start = text.indexOf(name);
    start !== -1;
    start = text.indexOf(name, start + 1)
  ) {
    const end = start + name.length;
    const before = [...text.slice(0, start)].at(-1);
    const after = [...text.slice(end)][0];
    if (inWord(units[0]) && inWord(before)) continue;
    if (inWord(units.at(-1)) && inWord(after)) continue;
    found.push({ start, end });
  }
  return found;
}

/**
 * The IDs of the characters (or other named records) that `text` names, by
 * name or alias, ignoring letter case.
 *
 * A name that starts or ends in a letter of a spaced script must stand as a
 * word. A name inside a longer name of another record does not count: with
 * "President" and "Vice President Shiraishi", the text "Vice President
 * Shiraishi" names only the second; with "会长" and "副会长", "副会长" names
 * only the second. Written by itself as well, the shorter name counts.
 */
export function mentionedCharacterIds(
  text: string | undefined,
  characters: readonly MentionableCharacter[],
): Set<string> {
  const haystack = (text ?? "").toLowerCase();
  const spans: Array<Span & { readonly id: string }> = [];
  if (haystack.length > 0) {
    for (const character of characters) {
      if (!character?.name || !character?.id) continue;
      const names: unknown[] = [
        character.name,
        ...(Array.isArray(character.aliases) ? character.aliases : []),
      ];
      for (const name of names) {
        if (typeof name !== "string" || name.trim().length === 0) continue;
        for (const span of occurrences(haystack, name.trim().toLowerCase()))
          spans.push({ ...span, id: character.id });
      }
    }
  }
  const ids = new Set<string>();
  for (const span of spans) {
    const covered = spans.some(
      (other) =>
        other.id !== span.id &&
        other.start <= span.start &&
        other.end >= span.end &&
        other.end - other.start > span.end - span.start,
    );
    if (!covered) ids.add(span.id);
  }
  return ids;
}
