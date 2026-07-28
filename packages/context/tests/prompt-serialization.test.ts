import { describe, expect, it } from "vitest";
import {
  MAX_CACHE_BREAKPOINTS,
  PROMPT_CACHE_BREAKPOINT_MARKER,
  splitPromptCacheSegments,
} from "@covel/shared";
import { serializeSystemPrompt } from "../src/prompt-serialization.js";

/** Count `PROMPT_CACHE_BREAKPOINT_MARKER` sentinels in a serialized prompt. */
function countCacheMarkers(prompt: string): number {
  return prompt.split(PROMPT_CACHE_BREAKPOINT_MARKER).length - 1;
}

function makeSegments(
  overrides?: Partial<Parameters<typeof serializeSystemPrompt>[0]>,
): Parameters<typeof serializeSystemPrompt>[0] {
  return {
    frameworkPreamble: "",
    workingMemory: "",
    pluginInstructions: "",
    worldInfoBeforePlugin: "",
    upstreamInjects: "",
    worldInfoAfterPlugin: "",
    ...overrides,
  };
}

describe("serializeSystemPrompt", () => {
  // Working memory is segment 2 by identity but is emitted last: it is the one
  // pre-history segment that changes every turn, and ahead of the plugin
  // instructions it invalidated the largest block in the prompt every time.
  it("emits working memory last so the stable blocks precede it", () => {
    const result = serializeSystemPrompt(
      makeSegments({
        frameworkPreamble: "framework",
        workingMemory: "memory",
        pluginInstructions: "plugin",
        worldInfoBeforePlugin: "before",
        upstreamInjects: "injects",
        worldInfoAfterPlugin: "after",
      }),
      false,
    );

    expect(result).toBe(
      "framework\n\nplugin\n\nbefore\n\ninjects\n\nafter\n\nmemory",
    );
  });

  it("skips empty segments without extra blank separators", () => {
    const result = serializeSystemPrompt(
      makeSegments({
        pluginInstructions: "plugin",
        upstreamInjects: "injects",
      }),
      false,
    );

    expect(result).toBe("plugin\n\ninjects");
    expect(result).not.toContain("\n\n\n");
  });

  it("marks only cacheable non-empty segments when cache breakpoints are enabled", () => {
    const result = serializeSystemPrompt(
      makeSegments({
        frameworkPreamble: "framework",
        workingMemory: "memory",
        pluginInstructions: "plugin",
        worldInfoBeforePlugin: "before",
        upstreamInjects: "injects",
        worldInfoAfterPlugin: "after",
      }),
      true,
    );

    const cacheSegments = splitPromptCacheSegments(result);
    // Three marked segments plus working memory as an unmarked trailing one.
    expect(cacheSegments).toHaveLength(4);
    expect(cacheSegments[0]).toBe("framework");
    // The plugin instructions — usually the biggest block — now own a cacheable
    // segment by themselves. Sharing one with working memory meant a few lines
    // of per-turn state invalidated the whole thing on every request.
    expect(cacheSegments[1]).toContain("plugin");
    expect(cacheSegments[1]).not.toContain("memory");
    expect(cacheSegments[1]).not.toContain("before");
    expect(cacheSegments[2]).toContain("before");
    expect(cacheSegments[2]).toContain("injects");
    expect(cacheSegments[2]).toContain("after");
    // Working memory trails the final marker. The prompt therefore no longer
    // ends with a sentinel, which is what makes the Anthropic adapter treat it
    // as an open tail and withhold cache_control from it.
    expect(cacheSegments[3]).toContain("memory");
    expect(result.endsWith("memory")).toBe(true);
    expect(result.split(PROMPT_CACHE_BREAKPOINT_MARKER)).toHaveLength(4);
  });

  it("does not emit cache markers for empty cacheable segments", () => {
    const result = serializeSystemPrompt(
      makeSegments({
        workingMemory: "memory",
        pluginInstructions: "plugin",
      }),
      true,
    );

    // Working memory follows the plugin marker as an unmarked tail. The split
    // helper only trims each segment's end, so the tail keeps the separator
    // that preceded it.
    expect(splitPromptCacheSegments(result)).toEqual(["plugin", "\n\nmemory"]);
  });
});

/**
 * Cross-package drift guard (audit H3 / A4).
 *
 * The Anthropic Messages adapter clamps the number of `cache_control` hints to
 * `MAX_CACHE_BREAKPOINTS` (the API's per-request cap). If the assembler emits
 * MORE sentinels than that, the surplus is silently truncated on the wire —
 * cache-hit rate quietly drops with no warning. This suite pins the contract
 * by running the REAL `serializeSystemPrompt` and asserting it never exceeds
 * the shared cap, so any future change that adds a cacheable segment beyond the
 * budget turns red here instead of degrading caching in production.
 */
describe("serializeSystemPrompt — cache-breakpoint budget contract", () => {
  it("emits no more markers than MAX_CACHE_BREAKPOINTS when every segment is populated", () => {
    // Every segment populated = the maximum number of sentinels the assembler
    // can produce in a single prompt.
    const fullyPopulated = serializeSystemPrompt(
      makeSegments({
        frameworkPreamble: "framework",
        workingMemory: "memory",
        pluginInstructions: "plugin",
        worldInfoBeforePlugin: "before",
        upstreamInjects: "injects",
        worldInfoAfterPlugin: "after",
      }),
      true,
    );

    expect(countCacheMarkers(fullyPopulated)).toBeLessThanOrEqual(
      MAX_CACHE_BREAKPOINTS,
    );
  });

  it("keeps every cacheable segment within the adapter's clamp budget", () => {
    // The adapter caps cacheable segments at MAX_CACHE_BREAKPOINTS. The number
    // of cacheable segments equals the marker count (each marker closes one
    // cacheable segment), so the assembler must stay within the same budget to
    // avoid silent truncation.
    const fullyPopulated = serializeSystemPrompt(
      makeSegments({
        frameworkPreamble: "framework",
        workingMemory: "memory",
        pluginInstructions: "plugin",
        worldInfoBeforePlugin: "before",
        upstreamInjects: "injects",
        worldInfoAfterPlugin: "after",
      }),
      true,
    );

    const markerCount = countCacheMarkers(fullyPopulated);
    // splitPromptCacheSegments drops the trailing open tail, so cacheable
    // segments == marker count. Both must fit the adapter's clamp.
    expect(markerCount).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
    expect(splitPromptCacheSegments(fullyPopulated).length).toBeLessThanOrEqual(
      MAX_CACHE_BREAKPOINTS,
    );
  });
});
