/**
 * Parse provider token counters at the wire boundary. Token counts are
 * non-negative safe integers; malformed, fractional, negative, or infinite
 * values must never flow into budgets, traces, or cost estimates.
 */
export function readTokenCount(value: unknown, fallback = 0): number {
  const count =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(count) && count >= 0 ? count : fallback;
}

export function readOptionalTokenCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const count = readTokenCount(value, Number.NaN);
  return Number.isNaN(count) ? undefined : count;
}

/** Saturating addition keeps provider counters inside the safe-integer ABI. */
export function sumTokenCounts(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    const count = readTokenCount(value);
    if (count > Number.MAX_SAFE_INTEGER - total) {
      return Number.MAX_SAFE_INTEGER;
    }
    total += count;
  }
  return total;
}

/**
 * Enforce the provider-independent usage contract: cache counters are
 * disjoint subsets of the inclusive input total.
 */
export function normalizeTokenUsage(options: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}) {
  const inputTokens = readTokenCount(options.inputTokens);
  const outputTokens = readTokenCount(options.outputTokens);
  const cachedInputTokens =
    options.cachedInputTokens === undefined
      ? undefined
      : Math.min(inputTokens, readTokenCount(options.cachedInputTokens));
  const cacheWriteInputTokens =
    options.cacheWriteInputTokens === undefined
      ? undefined
      : Math.min(
          inputTokens - (cachedInputTokens ?? 0),
          readTokenCount(options.cacheWriteInputTokens),
        );
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
  };
}
