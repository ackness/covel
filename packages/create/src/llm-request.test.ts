import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "@covel/shared";
import { LlmIdleTimeoutError, requestLlmResponse } from "./llm-request.js";

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

describe("requestLlmResponse idle timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  it("does not end a stream that keeps writing for longer than the timeout", async () => {
    vi.useFakeTimers();
    const lengths: number[] = [];
    const response = requestLlmResponse({
      llm: {
        async generate() {
          throw new Error("generate() should not be used when stream() exists");
        },
        // Five pieces, 80 ms apart: 400 ms in all against a 100 ms timeout.
        async *stream() {
          for (let piece = 0; piece < 5; piece++) {
            await pause(80);
            yield { type: "text-delta", textDelta: "ab" } as const;
          }
          yield { type: "done", finishReason: "stop" } as const;
        },
      },
      messages: [],
      signal: new AbortController().signal,
      idleTimeoutMs: 100,
      onText: (length) => lengths.push(length),
    });

    await vi.advanceTimersByTimeAsync(400);
    await expect(response).resolves.toMatchObject({ content: "ababababab" });
    expect(lengths).toEqual([2, 4, 6, 8, 10]);
  });

  it("counts reasoning as output of the model", async () => {
    vi.useFakeTimers();
    const response = requestLlmResponse({
      llm: {
        async generate() {
          throw new Error("generate() should not be used when stream() exists");
        },
        async *stream() {
          for (let piece = 0; piece < 3; piece++) {
            await pause(80);
            yield { type: "reasoning-delta", reasoningDelta: "…" } as const;
          }
          yield { type: "text-delta", textDelta: "answer" } as const;
          yield { type: "done", finishReason: "stop" } as const;
        },
      },
      messages: [],
      signal: new AbortController().signal,
      idleTimeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(240);
    await expect(response).resolves.toMatchObject({ content: "answer" });
  });

  it("does not count an empty piece as output of the model", async () => {
    vi.useFakeTimers();
    const response = requestLlmResponse({
      llm: {
        async generate() {
          throw new Error("generate() should not be used when stream() exists");
        },
        // The provider keeps the stream open with pieces that hold no text.
        async *stream() {
          for (;;) {
            await pause(80);
            yield { type: "text-delta", textDelta: "" } as const;
            yield { type: "reasoning-delta", reasoningDelta: "" } as const;
          }
        },
      },
      messages: [],
      signal: new AbortController().signal,
      idleTimeoutMs: 100,
    });
    const rejection =
      expect(response).rejects.toBeInstanceOf(LlmIdleTimeoutError);

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
  });

  it("ends a request when the model stays silent for the timeout", async () => {
    vi.useFakeTimers();
    let aborted: unknown;
    const response = requestLlmResponse({
      llm: {
        async generate() {
          throw new Error("generate() should not be used when stream() exists");
        },
        async *stream({ signal }) {
          signal?.addEventListener("abort", () => {
            aborted = signal.reason;
          });
          yield { type: "text-delta", textDelta: "first" } as const;
          // The provider holds the connection open and sends nothing more.
          await new Promise<never>(() => undefined);
        },
      },
      messages: [],
      signal: new AbortController().signal,
      idleTimeoutMs: 100,
    });
    const rejection =
      expect(response).rejects.toBeInstanceOf(LlmIdleTimeoutError);

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(aborted).toBeInstanceOf(LlmIdleTimeoutError);
  });

  it("gives the gateway a budget, so its 120 second default does not apply", async () => {
    let deadline = 0;
    await requestLlmResponse({
      llm: {
        async generate({ requestBudget }) {
          deadline = requestBudget?.deadline ?? 0;
          return {
            content: "answer",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
      },
      messages: [],
      signal: new AbortController().signal,
    });
    expect(deadline - Date.now()).toBeGreaterThan(120_000);
  });
});
