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
 * ## Emission
 *
 * The assembler emits this sentinel at stable cache boundaries. Adapters that
 * support explicit prompt caching split on the marker; other providers strip
 * or ignore it.
 */

/**
 * Invisible marker inserted at cache breakpoint boundaries inside a system
 * prompt. Chosen to be a PUA sequence so it never collides with user text
 * and does not render in any UI.
 */
export const PROMPT_CACHE_BREAKPOINT_MARKER = "\uE000COVEL_CACHE_BREAK\uE000";

/**
 * Single source of truth for the maximum number of explicit prompt-cache
 * breakpoints allowed inside one system prompt.
 *
 * This is a **cross-package contract** between two collaborators that never
 * import each other:
 *
 *   - The context assembler (`@covel/context` `serializeSystemPrompt`) emits
 *     at most this many `PROMPT_CACHE_BREAKPOINT_MARKER` sentinels (today it
 *     emits 3 \u2014 after the framework preamble, the plugin instructions, and the
 *     after-plugin world info).
 *   - The Anthropic Messages adapter (`@covel/ai-provider`) attaches
 *     `cache_control: { type: 'ephemeral' }` to each sentinel-preceded segment
 *     and **clamps** to this value, because the Anthropic Messages API rejects
 *     requests carrying more than 4 cache breakpoints.
 *
 * Keeping the cap here means the adapter's clamp and the assembler's emission
 * budget can never silently drift apart: a cross-package contract test
 * (`packages/context/tests/prompt-serialization.test.ts`) asserts the real
 * `serializeSystemPrompt` output never exceeds this many markers, so adding a
 * fourth-plus cacheable segment that would be silently truncated on the wire
 * turns the test red instead.
 */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Split a cached system prompt on breakpoint markers.
 *
 * Returns one segment per marker-delimited span. When the input string
 * contains no markers, a single-element array with the entire string is
 * returned.
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
