/**
 * Local token estimator for context budgeting. Pure, synchronous, zero deps.
 *
 * Ships with a character-based approximation tuned for mixed English + CJK
 * prose. Combined with the safety multipliers below this gives enough headroom
 * for "does this prompt fit the context window?" gates without pulling in a
 * real BPE tokenizer (the rank tables for o200k_base alone add several MB).
 *
 * If you need exact counts, replace the base counter via `setTokenCounter`:
 *
 * @example
 *   import { setTokenCounter } from "@covel/ai-provider";
 *   import { encode } from "gpt-tokenizer/encoding/o200k_base";
 *   setTokenCounter((text) => encode(text).length);
 */

export type ProviderFamily = "openai" | "anthropic" | "deepseek" | "qwen";

export interface EstimateTokensOptions {
  /**
   * Provider family used to apply a safety multiplier because each provider's
   * real tokenizer may report more tokens than our base counter for the same
   * text. Omit for OpenAI / default.
   */
  family?: ProviderFamily;
}

/**
 * Pluggable base counter. Receives raw text, returns the unscaled token count
 * before per-family safety multipliers are applied.
 */
export type TokenCounter = (text: string) => number;

/**
 * Default character-based approximation. Calibrated so CJK characters count
 * ~1.5× denser than the Latin/ASCII baseline, which matches o200k_base's
 * behaviour closely enough for budgeting once the safety multiplier is
 * applied. Zero deps, synchronous.
 */
export const approximateTokenCounter: TokenCounter = (text) => {
  if (text === "") {
    return 0;
  }

  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (
      (cp >= 0x3000 && cp <= 0x9fff) || // CJK symbols + unified ideographs
      (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
      (cp >= 0xff00 && cp <= 0xffef) || // Halfwidth / fullwidth forms
      (cp >= 0x20000 && cp <= 0x2ffff) // CJK extension B–F
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 4);
};

let activeCounter: TokenCounter = approximateTokenCounter;

/**
 * Override the base token counter. Intended extension point — plug in an
 * exact BPE tokenizer (e.g. gpt-tokenizer's o200k_base) when budget gating
 * needs higher precision than the built-in character heuristic provides.
 *
 * The override is process-wide and takes effect on the next `estimateTokens`
 * call. Safety multipliers are still applied on top.
 */
export function setTokenCounter(counter: TokenCounter): void {
  activeCounter = counter;
}

/** Restore the built-in character-based approximation. */
export function resetTokenCounter(): void {
  activeCounter = approximateTokenCounter;
}

/**
 * Safety multipliers per provider family. Calibrated so the estimate
 * over-reports rather than under-reports; context budgeting never underflows.
 *
 * - openai: base counter is already tuned to the GPT-4o family → 1.0.
 * - anthropic: Claude's tokenizer reports ~15–25% more tokens than o200k on
 *   mixed English/CJK text; 1.25 leaves safe headroom.
 * - deepseek / qwen: their 128k / 151k BPE vocabularies drift ~25–35% from
 *   our o200k-flavoured baseline on long-form Chinese; 1.35 keeps budgeting
 *   conservative.
 */
export const TOKEN_SAFETY_MULTIPLIERS: Readonly<
  Record<ProviderFamily, number>
> = Object.freeze({
  openai: 1.0,
  anthropic: 1.25,
  deepseek: 1.35,
  qwen: 1.35,
});

/**
 * Estimate the number of tokens a given text will consume for the given
 * provider family. Calls the active base counter (default: character
 * heuristic) and applies a per-family safety multiplier.
 *
 * Returns `0` for empty strings with no multiplier math.
 */
export function estimateTokens(
  text: string,
  options?: EstimateTokensOptions,
): number {
  if (text === "") {
    return 0;
  }

  const family: ProviderFamily = options?.family ?? "openai";
  const multiplier = TOKEN_SAFETY_MULTIPLIERS[family];
  const baseCount = activeCounter(text);

  return Math.ceil(baseCount * multiplier);
}
