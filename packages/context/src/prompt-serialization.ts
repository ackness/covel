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
 * Concatenate the pre-history V2 segments into the public systemPrompt string.
 * Empty segments are skipped so callers do not see stray blank separators.
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
  if (segments.workingMemory) parts.push(segments.workingMemory);
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

  return parts.join("\n\n");
}
