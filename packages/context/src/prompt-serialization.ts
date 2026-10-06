import { PROMPT_CACHE_BREAKPOINT_MARKER } from "@covel/shared";

export interface SerializablePromptSegments {
  readonly stableExtensions?: string;
  readonly turnExtensions?: string;
  readonly frameworkPreamble: string;
  readonly pluginInstructions: string;
  readonly worldInfoBeforePlugin: string;
  readonly sessionInjects: string;
  readonly worldInfoAfterPlugin: string;
}

/**
 * Concatenate the pre-history segments into the public systemPrompt string.
 * Empty segments are skipped so callers do not see stray blank separators.
 *
 * **Render order is by cache stability, not by segment number.** A segment
 * that changes every turn invalidates everything downstream of it, under both
 * caching models: an explicit `cache_control` segment is only reusable if its
 * whole body is unchanged, and an automatic prefix cache stops at the first
 * differing byte. So this turn's data and the turn-volatile
 * `position: "system"` segments are not part of this string at all: the
 * assembler places them behind the history. `turnExtensions` holds the
 * segments that change every turn and asked for `pre-history`; they are
 * emitted last, after every cacheable region.
 */
export function serializeSystemPrompt(
  segments: SerializablePromptSegments,
  injectCacheBreakpoints: boolean,
): string {
  const parts: string[] = [];
  const markerForCacheable = injectCacheBreakpoints
    ? PROMPT_CACHE_BREAKPOINT_MARKER
    : "";

  if (segments.frameworkPreamble) {
    parts.push(segments.frameworkPreamble + markerForCacheable);
  }
  if (segments.pluginInstructions) {
    parts.push(segments.pluginInstructions + markerForCacheable);
  }
  if (segments.stableExtensions)
    parts.push(segments.stableExtensions + markerForCacheable);
  if (segments.worldInfoBeforePlugin) {
    parts.push(segments.worldInfoBeforePlugin);
  }
  if (segments.sessionInjects) parts.push(segments.sessionInjects);
  if (segments.worldInfoAfterPlugin) {
    parts.push(segments.worldInfoAfterPlugin + markerForCacheable);
  }
  // Last, and deliberately outside every cacheable region: it differs each
  // turn, so anything after a breakpoint placed here could never be reused.
  if (segments.turnExtensions) parts.push(segments.turnExtensions);

  return parts.join("\n\n");
}
