/**
 * The dataset key rule: one spelling for every way a model or a person may
 * write the same name. Width variants fold to their plain form (NFKC),
 * leading and trailing whitespace go, every inner run of whitespace becomes
 * one space, and letters are lower-cased. "Old  Mara", "old mara" and
 * "ＯＬＤ ＭＡＲＡ" all become "old mara".
 *
 * Dataset tools key new records by it and look records up by it after the
 * exact key. Plugin code that writes a dataset keys its records with it so
 * the tools find them.
 */
export function datasetKey(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}
