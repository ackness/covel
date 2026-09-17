import { resolveBudgetOptions, type BudgetOptions } from "@covel/context";
import { resolveLlmTokenLimits, type LLMAdapter } from "@covel/shared";

/** Reserve the requested output before pruning the final provider request. */
export function resolveRequestContextBudget(
  base: Omit<BudgetOptions, "estimator">,
  llm: LLMAdapter,
  slot: string | undefined,
): Omit<BudgetOptions, "estimator"> {
  const target = llm.resolveBudget?.(slot);
  const limits = resolveLlmTokenLimits({
    contextWindow: Math.min(
      target?.contextWindow ?? base.maxInputTokens,
      base.contextWindowLimit ?? Infinity,
    ),
    maxOutputTokens: target?.maxOutputTokens,
    requestedMaxOutputTokens: target?.requestedMaxOutputTokens,
    defaultMaxOutputTokens: base.reservedForResponse,
  });
  return {
    ...base,
    ...resolveBudgetOptions({
      ...base,
      maxInputTokens: limits.contextWindow,
      reservedForResponse: limits.maxOutputTokens,
    }),
  };
}
