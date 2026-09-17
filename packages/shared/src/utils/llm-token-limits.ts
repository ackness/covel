export const DEFAULT_LLM_CONTEXT_WINDOW = 32_768;
export const DEFAULT_LLM_OUTPUT_TOKENS = 16_384;

/** Model capacity is a ceiling, never the default size of a response. */
export function resolveLlmTokenLimits(options: {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly requestedMaxOutputTokens?: number;
  readonly defaultMaxOutputTokens?: number;
}): { contextWindow: number; maxOutputTokens: number } {
  const contextWindow = options.contextWindow ?? DEFAULT_LLM_CONTEXT_WINDOW;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 2) {
    throw new RangeError(
      "contextWindow must be an integer of at least 2 tokens",
    );
  }
  const capacity = options.maxOutputTokens;
  if (
    capacity !== undefined &&
    (!Number.isSafeInteger(capacity) || capacity <= 0)
  ) {
    throw new RangeError("maxOutputTokens capacity must be a positive integer");
  }
  // Small windows need input space too. Only automatic defaults use this
  // split; an explicit request may reserve more than half of the window.
  const requested =
    options.requestedMaxOutputTokens ??
    Math.min(
      options.defaultMaxOutputTokens ?? DEFAULT_LLM_OUTPUT_TOKENS,
      Math.floor(contextWindow / 2),
    );
  if (
    !Number.isSafeInteger(requested) ||
    requested < 0 ||
    (options.requestedMaxOutputTokens !== undefined && requested === 0)
  ) {
    throw new RangeError("requestedMaxOutputTokens must be a positive integer");
  }
  const maxOutputTokens = Math.min(requested, capacity ?? Infinity);
  if (maxOutputTokens >= contextWindow) {
    throw new RangeError(
      `Requested output (${maxOutputTokens}) must leave input space in the context window (${contextWindow})`,
    );
  }
  return { contextWindow, maxOutputTokens };
}
