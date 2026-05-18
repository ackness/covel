import { describe, expect, it } from "vitest";
import {
  PROMPT_CACHE_BREAKPOINT_MARKER,
  splitPromptCacheSegments,
} from "@covel/shared";
import { serializeSystemPrompt } from "../src/prompt-serialization.js";

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
  it("joins non-empty pre-history segments in segment order", () => {
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
      "framework\n\nmemory\n\nplugin\n\nbefore\n\ninjects\n\nafter",
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
    expect(cacheSegments).toHaveLength(3);
    expect(cacheSegments[0]).toBe("framework");
    expect(cacheSegments[1]).toContain("memory");
    expect(cacheSegments[1]).toContain("plugin");
    expect(cacheSegments[1]).not.toContain("before");
    expect(cacheSegments[2]).toContain("before");
    expect(cacheSegments[2]).toContain("injects");
    expect(cacheSegments[2]).toContain("after");
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

    expect(splitPromptCacheSegments(result)).toEqual(["memory\n\nplugin"]);
  });
});
