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
  let cjkCount = 0;
  // Count UTF-16 code units, just like the original non-Unicode regex.
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    )
      cjkCount += 1;
  }
  return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}
