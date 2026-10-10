// A letter or digit of a script that writes words with spaces between them.
// Chinese, Japanese and Korean text has no such boundary, so a name written in
// it may start or end anywhere.
const SPACED_WORD_CHARACTER =
  /^(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}]$/u;

function inWord(character) {
  return character !== undefined && SPACED_WORD_CHARACTER.test(character);
}

/**
 * Where `name` is written in `text` (both lower case). A name that starts or
 * ends with a letter of a spaced script must stand as a word: "Al" is not in
 * "also".
 */
function occurrences(text, name) {
  const found = [];
  for (
    let start = text.indexOf(name);
    start !== -1;
    start = text.indexOf(name, start + 1)
  ) {
    const end = start + name.length;
    const before = [...text.slice(0, start)].at(-1);
    const after = [...text.slice(end)][0];
    if (inWord([...name][0]) && inWord(before)) continue;
    if (inWord([...name].at(-1)) && inWord(after)) continue;
    found.push({ start, end });
  }
  return found;
}

/**
 * The IDs of the graph nodes that `text` names, by name or alias.
 *
 * A name inside a longer name of another node does not count: with the nodes
 * "莲" and "莲花镇", the message "去莲花镇" names only the town.
 *
 * @param {string} text
 * @param {ReadonlyArray<{ id?: string, name?: string, aliases?: unknown }>} nodes
 * @returns {Set<string>}
 */
export function mentionedNodeIds(text, nodes) {
  const haystack = (text ?? "").toLowerCase();
  const spans = [];
  if (haystack.length > 0) {
    for (const node of nodes) {
      if (!node?.name || !node?.id) continue;
      const names = [
        node.name,
        ...(Array.isArray(node.aliases) ? node.aliases : []),
      ];
      for (const name of names) {
        if (typeof name !== "string" || name.trim().length === 0) continue;
        for (const span of occurrences(haystack, name.trim().toLowerCase()))
          spans.push({ ...span, id: node.id });
      }
    }
  }
  const ids = new Set();
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
