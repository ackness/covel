import { describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "@covel/shared";
import { requestLlmResponse } from "./llm-request.js";

describe("requestLlmResponse", () => {
  it("does not call a provider after cancellation", async () => {
    const generate = vi.fn();
    const stream = vi.fn();
    for (const llm of [{ generate }, { generate, stream }]) {
      await expect(
        requestLlmResponse({
          llm,
          messages: [],
          signal: AbortSignal.abort(),
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    }
    expect(generate).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it("rejects a late non-streaming result after cancellation", async () => {
    const controller = new AbortController();
    await expect(
      requestLlmResponse({
        llm: {
          generate: async () => {
            controller.abort();
            return {
              content: "late",
              toolCalls: [],
              finishReason: "stop",
              usage: { inputTokens: 0, outputTokens: 0 },
            };
          },
        },
        messages: [],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("closes a streaming iterator when cancelled output arrives", async () => {
    const controller = new AbortController();
    const cleanup = vi.fn();
    const generate = vi.fn();
    await expect(
      requestLlmResponse({
        llm: {
          generate,
          async *stream() {
            try {
              controller.abort();
              yield { type: "text-delta", textDelta: "late" } as const;
              throw new Error("cancelled stream was consumed further");
            } finally {
              cleanup();
            }
          },
        },
        messages: [],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
  });

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
