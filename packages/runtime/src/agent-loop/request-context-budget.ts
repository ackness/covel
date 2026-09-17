import { resolveBudgetOptions, type BudgetOptions } from "@covel/context";
import type { LLMAdapter } from "@covel/shared";

/** Reserve the requested output before pruning the final provider request. */
export function resolveRequestContextBudget(
  base: Omit<BudgetOptions, "estimator">,
  llm: LLMAdapter,
  slot: string | undefined,
): Omit<BudgetOptions, "estimator"> {
  const target = llm.resolveBudget?.(slot);
  if (!target) return base;
  const limits = resolveBudgetOptions(base);
  const requested =
    target.requestedMaxOutputTokens ?? limits.reservedForResponse;
  return {
    ...base,
    ...resolveBudgetOptions({
      ...base,
      maxInputTokens: Math.min(
        limits.maxInputTokens,
        target.contextWindow ?? Infinity,
      ),
      reservedForResponse: Math.min(
        requested,
        target.maxOutputTokens ?? Infinity,
      ),
    }),
  };
}
