/** Space-delimited words and overlapping bigrams for unsegmented CJK text. */
export function keywordTerms(text: string): string[] {
  const terms: string[] = [];
  for (const part of text
    .toLowerCase()
    .match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}_])+/gu,
    ) ?? []) {
    if (
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
        part,
      )
    ) {
      const characters = [...part];
      if (characters.length === 1) terms.push(part);
      for (let index = 1; index < characters.length; index++)
        terms.push(characters[index - 1]! + characters[index]!);
    } else if (part.length >= 2) terms.push(part);
  }
  return [...new Set(terms)];
}

/** Keep the first match in view rather than returning an unrelated prefix. */
export function keywordExcerpt(
  text: string,
  terms: readonly string[],
  limit = 500,
): string {
  if (text.length <= limit) return text;
  const lower = text.toLowerCase();
  const positions = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0);
  const start = Math.max(
    0,
    (positions.length ? Math.min(...positions) : 0) - 120,
  );
  const end = Math.min(text.length, start + limit);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
