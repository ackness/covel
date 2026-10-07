/**
 * CJK ranges: radicals/kana/ideographs (2E80–9FFF), Hangul syllables
 * (AC00–D7AF), compatibility ideographs (F900–FAFF), fullwidth forms
 * (FF00–FFEF).
 */
const CJK_RE = /[⺀-鿿가-힯豈-﫿＀-￯]/g;

/**
 * Default character-heuristic token estimator, CJK-aware.
 *
 * The naive `chars / 4` rule undercounts CJK text ~3× (CJK runs at roughly
 * 1–1.7 characters per token across common tokenizers), which let Chinese
 * sessions blow past the real model window long before the estimate tripped
 * any threshold. Count CJK characters at 1 token each (deliberately on the
 * high side — overestimating triggers compaction early, which is the safe
 * direction) and everything else at 4 chars per token.
 */
export function estimateTokens(text: string): number {
  const cjkCount = text.match(CJK_RE)?.length ?? 0;
  return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}
