/**
 * Lexical relevance ranking that needs no embedding model.
 *
 * The kernel's memory search and a plugin that ranks its own records use this
 * one implementation, so both give the same order for the same text.
 */

const CJK =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const PART = new RegExp(`[${CJK}]+|(?:(?![${CJK}])[\\p{L}\\p{N}_])+`, "gu");
const CJK_START = new RegExp(`^[${CJK}]`, "u");

/** Okapi BM25 constants: term-frequency saturation and length normalization. */
const K1 = 1.2;
const B = 0.75;

/** `lanterns` and `lantern's` are the word `lantern`. */
function wordStem(word: string): string {
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss"))
    return word.slice(0, -1);
  return word;
}

function parts(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/['’]s\b/g, "")
      .match(PART) ?? []
  );
}

/**
 * The terms a query asks for: words of two or more characters, and the
 * overlapping two-character pairs of text written without spaces. A single
 * Chinese, Japanese or Korean character is a term of its own.
 */
export function searchTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const part of parts(text)) {
    if (!CJK_START.test(part)) {
      if (part.length >= 2) terms.add(wordStem(part));
      continue;
    }
    const characters = [...part];
    if (characters.length === 1) terms.add(part);
    for (let index = 1; index < characters.length; index++)
      terms.add(characters[index - 1]! + characters[index]!);
  }
  return [...terms];
}

/** Term counts of a document. Single characters are counted too, so a one-character query finds them. */
function documentTerms(text: string): {
  counts: Map<string, number>;
  length: number;
} {
  const counts = new Map<string, number>();
  let length = 0;
  const add = (term: string) => counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const part of parts(text)) {
    if (!CJK_START.test(part)) {
      if (part.length >= 2) {
        add(wordStem(part));
        length++;
      }
      continue;
    }
    const characters = [...part];
    for (const [index, character] of characters.entries()) {
      add(character);
      if (index > 0) add(characters[index - 1]! + character);
    }
    // The length counts positions, not the two terms each position adds.
    length += characters.length;
  }
  return { counts, length };
}

export interface RankedText {
  /** Position of the text in the list that was ranked. */
  readonly index: number;
  /** BM25 score. It orders the texts of one call and means nothing across calls. */
  readonly score: number;
  /**
   * How much of the query the text answers, from 0 to 1: the weight of the
   * query terms it holds over the weight of the query terms that any text
   * holds. A rare term weighs more than a common one. A query term that no
   * text holds is not counted: it tells nothing about which text is closer.
   */
  readonly coverage: number;
  /**
   * How many of the query's terms the text holds. Over the number of
   * `searchTerms(query)` it says how much of the query is about this text; a
   * long query that shares one everyday word with a text gives a small part.
   */
  readonly matched: number;
}

export interface RankTextsOptions {
  /** Most results to return. All matches when omitted. */
  readonly limit?: number;
  /** Leave out a text that answers less of the query than this. Default 0. */
  readonly minCoverage?: number;
}

/**
 * Rank texts against a query with Okapi BM25. A term that most texts hold
 * counts for little and a term that few hold counts for much, so a name
 * outweighs a common word. Texts that hold no query term are left out. Equal
 * scores keep the order of the list.
 */
export function rankTexts(
  query: string,
  texts: readonly string[],
  options: RankTextsOptions = {},
): RankedText[] {
  const queryTerms = searchTerms(query);
  if (queryTerms.length === 0 || texts.length === 0) return [];

  const documents = texts.map(documentTerms);
  const averageLength =
    documents.reduce((sum, document) => sum + document.length, 0) /
      documents.length || 1;
  const weights = new Map<string, number>();
  let totalWeight = 0;
  for (const term of queryTerms) {
    let holders = 0;
    for (const document of documents) if (document.counts.has(term)) holders++;
    const weight = Math.log(
      1 + (documents.length - holders + 0.5) / (holders + 0.5),
    );
    weights.set(term, weight);
    if (holders > 0) totalWeight += weight;
  }

  const ranked: RankedText[] = [];
  for (const [index, document] of documents.entries()) {
    let score = 0;
    let matched = 0;
    let matchedWeight = 0;
    for (const term of queryTerms) {
      const count = document.counts.get(term);
      if (!count) continue;
      const weight = weights.get(term)!;
      matched++;
      matchedWeight += weight;
      score +=
        (weight * count * (K1 + 1)) /
        (count + K1 * (1 - B + (B * document.length) / averageLength));
    }
    if (score <= 0) continue;
    const coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
    if (coverage < (options.minCoverage ?? 0)) continue;
    ranked.push({ index, score, coverage, matched });
  }
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return options.limit === undefined ? ranked : ranked.slice(0, options.limit);
}

/** The part of a long text around its first query term, at most `limit` characters. */
export function searchExcerpt(
  text: string,
  query: string,
  limit = 500,
): string {
  if (text.length <= limit) return text;
  const lower = text.toLowerCase();
  const positions = searchTerms(query)
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0);
  const start = Math.max(
    0,
    (positions.length ? Math.min(...positions) : 0) - 120,
  );
  const end = Math.min(text.length, start + limit);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
