/**
 * Local token estimator built on gpt-tokenizer's cl100k_base encoding.
 * Pure, synchronous, zero network — foundation for context budgeting.
 * Applies a per-provider safety multiplier because cl100k systematically
 * under-counts Anthropic and Chinese-model tokens.
 */

import { encode } from "gpt-tokenizer";

export type ProviderFamily = "openai" | "anthropic" | "deepseek" | "qwen";

export interface EstimateTokensOptions {
  /**
   * Provider family used to apply a safety multiplier because cl100k_base
   * systematically under-counts Claude and Chinese-model tokens.
   * Omit for OpenAI / default.
   */
  family?: ProviderFamily;
}

/**
 * Safety multipliers per provider family.
 *
 * - openai: cl100k_base IS the OpenAI tokenizer for GPT-3.5/4/4o → 1.0.
 * - anthropic: Anthropic's own count_tokens reports ~15–20% more tokens than
 *   cl100k for English; use 1.25 to add ~10% headroom.
 * - deepseek / qwen: Chinese-heavy models drift ~30% from cl100k; use 1.35.
 */
export const TOKEN_SAFETY_MULTIPLIERS: Readonly<Record<ProviderFamily, number>> =
  Object.freeze({
    openai: 1.0,
    anthropic: 1.25,
    deepseek: 1.35,
    qwen: 1.35,
  });

/**
 * Estimate the number of tokens a given text will consume for the given
 * provider family. Uses cl100k_base as the universal base encoder and applies
 * a safety multiplier so we never under-report.
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
  const baseCount = encode(text).length;

  return Math.ceil(baseCount * multiplier);
}
