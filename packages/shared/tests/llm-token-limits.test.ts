import { describe, expect, it } from "vitest";
import { resolveLlmTokenLimits } from "../src/utils/llm-token-limits.js";

describe("LLM token limits", () => {
  it.each([
    [{}, 16_384],
    [{ contextWindow: 200_000, maxOutputTokens: 262_144 }, 16_384],
    [{ contextWindow: 16_384, maxOutputTokens: 16_384 }, 8192],
    [{ contextWindow: 8192, maxOutputTokens: 65_536 }, 4096],
    [{ contextWindow: 16_384, requestedMaxOutputTokens: 4096 }, 4096],
    [{ contextWindow: 16_384, requestedMaxOutputTokens: 12_000 }, 12_000],
    [{ contextWindow: 65_536, requestedMaxOutputTokens: 32_768 }, 32_768],
    [
      {
        contextWindow: 65_536,
        requestedMaxOutputTokens: 32_768,
        maxOutputTokens: 8192,
      },
      8192,
    ],
  ])("resolves %j to %s output tokens", (options, expected) => {
    expect(resolveLlmTokenLimits(options).maxOutputTokens).toBe(expected);
  });

  it("rejects an explicit output request that leaves no input space", () => {
    expect(() =>
      resolveLlmTokenLimits({
        contextWindow: 16_384,
        requestedMaxOutputTokens: 16_384,
      }),
    ).toThrow(RangeError);
  });
});
