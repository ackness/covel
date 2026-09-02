import { describe, expect, it } from "vitest";
import type { LLMAdapter } from "@covel/shared";
import { requestLlmResponse } from "./llm-request.js";

describe("requestLlmResponse", () => {
  it("preserves the existing streaming response behavior", async () => {
    const llm: LLMAdapter = {
      async generate() {
        throw new Error("generate() should not be used when stream() exists");
      },
      async *stream() {
        yield { type: "text-delta", textDelta: "repaired " } as const;
        yield { type: "text-delta", textDelta: "lore" } as const;
        yield {
          type: "done",
          finishReason: "length",
          reasoningContent: "repair reasoning",
        } as const;
      },
    };

    const response = await requestLlmResponse({
      llm,
      messages: [{ role: "user", content: "repair" }],
      signal: AbortSignal.timeout(5_000),
    });

    expect(response.content).toBe("repaired lore");
    expect(response.finishReason).toBe("length");
    expect(response.reasoningContent).toBe("repair reasoning");
  });
});
