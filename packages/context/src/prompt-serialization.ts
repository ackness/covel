import { PROMPT_CACHE_BREAKPOINT_MARKER } from "@covel/shared";

export interface SerializablePromptSegments {
  readonly frameworkPreamble: string;
  readonly workingMemory: string;
  readonly pluginInstructions: string;
  readonly worldInfoBeforePlugin: string;
  readonly upstreamInjects: string;
  readonly worldInfoAfterPlugin: string;
}

/**
 * Concatenate the pre-history segments into the public systemPrompt string.
 * Empty segments are skipped so callers do not see stray blank separators.
 *
 * **Render order is by cache stability, not by segment number.** Working
 * memory carries the segment-2 identity in {@link PromptSegments}, but it is
 * emitted last, after the world-info segments. It is the one pre-history
 * segment that changes every single turn, and while it sat between the
 * framework preamble and the plugin instructions it invalidated everything
 * downstream of it: the instructions are usually the largest block in the
 * prompt, and they were re-billed every turn purely because a few lines of
 * memory ahead of them had changed. That penalty applies to both caching
 * models — an explicit `cache_control` segment is only reusable if its whole
 * body is unchanged, and an automatic prefix cache stops at the first
 * differing byte.
 *
 * Emitting it last also puts the turn's freshest state nearest the
 * conversation, which is where a model weighs it most heavily.
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
  if (segments.worldInfoBeforePlugin) {
    parts.push(segments.worldInfoBeforePlugin);
  }
  if (segments.upstreamInjects) parts.push(segments.upstreamInjects);
  if (segments.worldInfoAfterPlugin) {
    parts.push(segments.worldInfoAfterPlugin + markerForCacheable);
  }
  // Last, and deliberately outside every cacheable region: it differs each
  // turn, so anything after a breakpoint placed here could never be reused.
  if (segments.workingMemory) parts.push(segments.workingMemory);

  return parts.join("\n\n");
}
