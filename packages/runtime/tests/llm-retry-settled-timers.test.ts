import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LLMAdapter,
  LLMMessage,
  LLMProviderRequest,
  LLMResponse,
  LLMStreamEvent,
} from "@covel/shared";
import {
  callLLMWithRetry,
  streamLLMWithRetry,
} from "../src/retry/llm-retry.js";
import { buildRetryPolicy } from "../src/retry/retry-common.js";
import { TurnAbortedError } from "../src/turn-executor/turn-control.js";

const messages: readonly LLMMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "ping" },
];

function providerRequest(
  overrides: Partial<LLMProviderRequest> = {},
): LLMProviderRequest {
  return {
    schemaVersion: 1,
    provider: "fixture",
    protocol: "openai-chat-v1",
    body: {},
    complete: true,
    omittedFieldCount: 0,
    startedAt: "2026-11-21T00:00:00.000Z",
    durationMs: 5,
    transportAttempt: 0,
    ...overrides,
  };
}

describe("post-settled timer re-arming guards in llm-retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not arm an orphaned timeout in callLLMWithRetry when onQueueStart ends after abort", async () => {
    let endQueue: ((waitedMs: number) => void) | undefined;
    let capturedOnQueueStart: (() => (waitedMs: number) => void) | undefined;
    const onQueueWait = vi.fn();

    const llm: LLMAdapter = {
      generate(params): Promise<LLMResponse> {
        capturedOnQueueStart = params.onQueueStart;
        endQueue = params.onQueueStart?.();
        return new Promise((_resolve, reject) => {
          params.signal?.addEventListener(
            "abort",
            () => reject(params.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    };

    const controller = new AbortController();
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 60_000,
      callTimeoutMs: 30_000,
      maxRetries: 0,
    });

    const pending = callLLMWithRetry({
      llm,
      messages,
      policy,
      deadline: Date.now() + 60_000,
      abortSignal: controller.signal,
      onQueueWait,
    });

    controller.abort(new Error("player cancelled"));
    await expect(pending).rejects.toBeInstanceOf(TurnAbortedError);
    expect(vi.getTimerCount()).toBe(0);

    // Late gateway callback arriving after settlement must not arm a new timer or notify onQueueWait.
    endQueue?.(150);
    capturedOnQueueStart?.()(50);

    expect(onQueueWait).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not arm orphaned guards in streamLLMWithRetry when onQueueStart ends after abort", async () => {
    let endQueue: ((waitedMs: number) => void) | undefined;
    const onQueueWait = vi.fn();

    const llm: LLMAdapter = {
      async generate() {
        throw new Error("unused");
      },
      async *stream(params): AsyncIterable<LLMStreamEvent> {
        endQueue = params.onQueueStart?.();
        await new Promise<void>((_resolve, reject) => {
          params.signal?.addEventListener(
            "abort",
            () => reject(params.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    };

    const controller = new AbortController();
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 60_000,
      firstTokenTimeoutMs: 10_000,
      maxRetries: 0,
    });

    const pending = streamLLMWithRetry({
      llm,
      messages,
      policy,
      deadline: Date.now() + 60_000,
      abortSignal: controller.signal,
      onQueueWait,
    });

    controller.abort(new Error("player cancelled"));
    await expect(pending).rejects.toBeInstanceOf(TurnAbortedError);
    expect(vi.getTimerCount()).toBe(0);

    endQueue?.(200);

    expect(onQueueWait).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not re-arm first-token guard in streamLLMWithRetry when onProviderRequest fires after abort", async () => {
    let capturedOnProviderRequest:
      ((req: LLMProviderRequest) => void) | undefined;

    const llm: LLMAdapter = {
      async generate() {
        throw new Error("unused");
      },
      async *stream(params): AsyncIterable<LLMStreamEvent> {
        capturedOnProviderRequest = params.onProviderRequest;
        // Pause the first-token guard via a 429 transport attempt, then wait until aborted.
        params.onProviderRequest?.(
          providerRequest({ failed: true, statusCode: 429 }),
        );
        await new Promise<void>((_resolve, reject) => {
          params.signal?.addEventListener(
            "abort",
            () => reject(params.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    };

    const controller = new AbortController();
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 60_000,
      firstTokenTimeoutMs: 10_000,
      maxRetries: 0,
    });

    const pending = streamLLMWithRetry({
      llm,
      messages,
      policy,
      deadline: Date.now() + 60_000,
      abortSignal: controller.signal,
    });

    controller.abort(new Error("player cancelled"));
    await expect(pending).rejects.toBeInstanceOf(TurnAbortedError);
    expect(vi.getTimerCount()).toBe(0);

    // Late retry-response callback arriving after abort must not restart the TTFB timer.
    capturedOnProviderRequest?.(
      providerRequest({ statusCode: 200, transportAttempt: 1 }),
    );

    expect(vi.getTimerCount()).toBe(0);
  });
});
