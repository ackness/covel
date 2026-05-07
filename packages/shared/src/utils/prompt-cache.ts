/**
 * Prompt cache breakpoint marker — §A15 of the improvement plan.
 *
 * S2-T3 introduces a cross-provider prompt cache abstraction. The context
 * assembler (`@covel/context`) and provider adapters (`@covel/ai-provider`)
 * need to agree on a sentinel string that marks logical cache breakpoints
 * inside a single concatenated `systemPrompt`. Defining the constant here
 * in `@covel/shared` keeps both packages decoupled while guaranteeing they
 * use the exact same byte sequence.
 *
 * ## Why a sentinel?
 *
 * The turn executor (see `packages/runtime/src/turn-executor.ts`) builds a
 * single `system` LLM message from `AssembledContext.systemPrompt: string`
 * and forwards it through the gateway to each provider adapter. There is
 * currently no structural channel to carry per-segment cache metadata
 * between the context builder and the adapter.
 *
 * Rather than breaking the `AssembledContext` contract (which would ripple
 * into runtime and every consumer), the context assembler embeds an
 * **invisible, stable sentinel** at each cache breakpoint. Adapters that
 * support explicit cache hints (currently Anthropic Messages) split on the
 * sentinel and attach `cache_control: { type: 'ephemeral' }` to the
 * preceding segment. Adapters that rely on automatic prefix matching
 * (OpenAI / DeepSeek / Qwen) leave the string untouched — the sentinel is
 * stable across calls, so it does not break prefix stability.
 *
 * ## Invisibility guarantees
 *
 * The sentinel uses a PUA (Private Use Area) character `\uE000` which:
 *   - Never appears in legitimate prose
 *   - Is not rendered by any standard font (effectively invisible)
 *   - Survives JSON serialization intact
 *   - Tokenizes consistently across models so it does not jitter prompt cost
 *
 * ## Feature gating
 *
 * The sentinel is only emitted when `COVEL_PROMPT_CACHE_V1=1`. When the
 * flag is off, the assembler produces a bit-identical prompt to the
 * pre-S2-T3 behaviour and adapters hit the legacy code path.
 *
 * Spec: `devs/docs/insights/covel-improvement-plan.md` §A15
 */

/**
 * Invisible marker inserted at cache breakpoint boundaries inside a system
 * prompt. Chosen to be a PUA sequence so it never collides with user text
 * and does not render in any UI.
 */
export const PROMPT_CACHE_BREAKPOINT_MARKER = "\uE000COVEL_CACHE_BREAK\uE000";

/**
 * Split a cached system prompt on breakpoint markers.
 *
 * Returns one segment per marker-delimited span. When the input string
 * contains no markers (feature flag off, or adapter working on a legacy
 * prompt) a single-element array with the entire string is returned.
 *
 * @param systemPrompt - The assembled system prompt, possibly containing
 *   `PROMPT_CACHE_BREAKPOINT_MARKER` at logical cache boundaries.
 * @returns Array of plain-text segments in document order. Empty segments
 *   are filtered out so adapters never send a degenerate cache breakpoint.
 */
export function splitPromptCacheSegments(
  systemPrompt: string,
): readonly string[] {
  if (!systemPrompt) return [];
  if (!systemPrompt.includes(PROMPT_CACHE_BREAKPOINT_MARKER)) {
    return [systemPrompt];
  }
  return systemPrompt
    .split(PROMPT_CACHE_BREAKPOINT_MARKER)
    .map((segment) => segment.trimEnd())
    .filter((segment) => segment.length > 0);
}

/**
 * Strip all breakpoint markers from a system prompt without splitting.
 *
 * Useful for adapters that support automatic prefix-based caching and do
 * not need the segment structure — they can drop the sentinels entirely
 * and send a clean string. Note that leaving the sentinels in place is
 * also fine; this helper exists for adapters that want to minimize wire
 * bytes and keep upstream logs clean.
 */
export function stripPromptCacheMarkers(systemPrompt: string): string {
  if (!systemPrompt || !systemPrompt.includes(PROMPT_CACHE_BREAKPOINT_MARKER)) {
    return systemPrompt;
  }
  // Collapse adjacent newlines that bracketed the marker back into the
  // standard `\n\n` separator used between segments.
  return systemPrompt.split(PROMPT_CACHE_BREAKPOINT_MARKER).join("");
}
