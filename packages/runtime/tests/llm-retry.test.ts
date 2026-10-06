/**
 * Unit tests for the smart LLM retry helpers.
 *
 * Uses tiny in-file Mock LLM adapters instead of @covel/plugin-test-utils'
 * MockLLM so we can:
 *   - count attempts per test case
 *   - throw specific errors on specific attempts
 *   - drive streaming first-token latency deterministically
 *
 * No network, no timers beyond the retry helpers' own AbortSignal.timeout —
 * tests finish in < 100ms each.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRetryPolicy,
  callLLMWithRetry,
  streamLLMWithRetry,
  detectToolLoop,
  perturbMessages,
  isTransientError,
  LLMRetryError,
  DEFAULT_MAX_RETRIES,
  DEFAULT_LOOP_THRESHOLD,
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
} from "../src/retry/llm-retry.js";
import { computeAttemptBudget } from "../src/retry/retry-common.js";
import type {
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  LLMStreamEvent,
} from "../src/llm/llm-adapter.js";
import type { LLMProviderRequest } from "@covel/shared";

// ── Mock LLM builders ───────────────────────────────────────────────

interface MockGenerateOutcome {
  readonly kind: "ok" | "throw";
  readonly response?: LLMResponse;
  readonly error?: Error;
}

/** Non-streaming LLM that replays a scripted sequence of outcomes. */
function createScriptedLLM(outcomes: MockGenerateOutcome[]): LLMAdapter & {
  readonly calls: LLMMessage[][];
} {
  const calls: LLMMessage[][] = [];
  const queue = [...outcomes];
  return {
    calls,
    async generate(params): Promise<LLMResponse> {
      calls.push([...params.messages]);
      const next = queue.shift();
      if (!next) throw new Error("scripted LLM queue empty");
      if (next.kind === "throw") throw next.error!;
      return next.response!;
    },
  };
}

/** Streaming LLM that yields scripted events then optionally throws. */
interface StreamScript {
  readonly events: Array<LLMStreamEvent | { delay: number }>;
  readonly throwAtEnd?: Error;
}

function createScriptedStreamLLM(scripts: StreamScript[]): LLMAdapter & {
  readonly attempts: number;
} {
  let attempts = 0;
  const llm: LLMAdapter & { attempts: number } = {
    get attempts() {
      return attempts;
    },
    async generate(): Promise<LLMResponse> {
      return {
        content: "FALLBACK",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    async *stream(params): AsyncIterable<LLMStreamEvent> {
      const script = scripts[attempts++];
      if (!script) throw new Error("stream script queue empty");
      for (const item of script.events) {
        if ("delay" in item) {
          // Honour the abort signal so TTFB guard can fire mid-wait.
          await waitWithSignal(item.delay, params.signal);
          continue;
        }
        yield item;
      }
      if (script.throwAtEnd) throw script.throwAtEnd;
    },
  };
  return llm;
}

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? "aborted")),
      );
      return;
    }
    const handle = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(handle);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error(String(signal.reason ?? "aborted")),
        );
      },
      { once: true },
    );
  });
}

const baseMessages: readonly LLMMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "ping" },
];

function okResponse(text = "pong"): LLMResponse {
  return {
    content: text,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

// ── buildRetryPolicy ────────────────────────────────────────────────

describe("buildRetryPolicy", () => {
  it("uses sensible defaults when fields are omitted", () => {
    const policy = buildRetryPolicy({ runtimeTimeoutMs: 120_000 });
    expect(policy.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(policy.firstTokenTimeoutMs).toBe(DEFAULT_FIRST_TOKEN_TIMEOUT_MS);
    expect(policy.loopDetectionThreshold).toBe(DEFAULT_LOOP_THRESHOLD);
    // 120000 / 2 = 60000, capped at DEFAULT_CALL_TIMEOUT_CAP_MS (60000).
    expect(policy.callTimeoutMs).toBe(60_000);
  });

  it("honours explicit overrides", () => {
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 30_000,
      maxRetries: 2,
      callTimeoutMs: 8_000,
      firstTokenTimeoutMs: 5_000,
      loopDetectionThreshold: 5,
    });
    expect(policy.maxRetries).toBe(2);
    expect(policy.callTimeoutMs).toBe(8_000);
    expect(policy.firstTokenTimeoutMs).toBe(5_000);
    expect(policy.loopDetectionThreshold).toBe(5);
  });

  it("clamps maxRetries to [0, 5]", () => {
    expect(
      buildRetryPolicy({ runtimeTimeoutMs: 60_000, maxRetries: -1 }).maxRetries,
    ).toBe(0);
    expect(
      buildRetryPolicy({ runtimeTimeoutMs: 60_000, maxRetries: 99 }).maxRetries,
    ).toBe(5);
  });

  it("derives a floor-ed callTimeout so very small budgets stay usable", () => {
    const policy = buildRetryPolicy({ runtimeTimeoutMs: 2_000 });
    // Default split 2000 / 2 = 1000 → clamp up to MIN_CALL_TIMEOUT_MS (5000).
    expect(policy.callTimeoutMs).toBeGreaterThanOrEqual(5_000);
  });
});

// ── isTransientError ────────────────────────────────────────────────

describe("isTransientError", () => {
  it("classifies common transient failures", () => {
    expect(isTransientError(new Error("Request aborted"))).toBe(true);
    expect(
      isTransientError(new Error("The operation was aborted due to timeout")),
    ).toBe(true);
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
    expect(isTransientError(new Error("rate limited"))).toBe(true);
    expect(isTransientError(new Error("PROVIDER_ERROR: upstream 502"))).toBe(
      true,
    );
    expect(isTransientError(new Error("HTTP 503 Service Unavailable"))).toBe(
      true,
    );
  });

  it("does not retry schema / client errors", () => {
    expect(isTransientError(new Error("HTTP 400 Bad Request"))).toBe(false);
    expect(isTransientError(new Error("invalid tool arguments"))).toBe(false);
    expect(isTransientError(new Error("random failure"))).toBe(false);
  });
});

// ── detectToolLoop ──────────────────────────────────────────────────

describe("detectToolLoop", () => {
  const mk = (name: string, args: string) => ({ name, arguments: args });

  it("returns false when threshold is 0", () => {
    expect(
      detectToolLoop([mk("x", "{}"), mk("x", "{}"), mk("x", "{}")], 0),
    ).toBe(false);
  });

  it("returns false when fewer than threshold calls exist", () => {
    expect(detectToolLoop([mk("a", "{}")], 3)).toBe(false);
  });

  it("returns true for N identical trailing calls", () => {
    expect(
      detectToolLoop(
        [mk("a", "{}"), mk("b", "{}"), mk("b", "{}"), mk("b", "{}")],
        3,
      ),
    ).toBe(true);
  });

  it("ignores earlier dissimilar calls", () => {
    expect(
      detectToolLoop([mk("a", "{}"), mk("a", "{}"), mk("b", "{}")], 3),
    ).toBe(false);
  });

  it("treats different arg strings as different calls", () => {
    expect(
      detectToolLoop(
        [mk("x", '{"v":1}'), mk("x", '{"v":2}'), mk("x", '{"v":1}')],
        3,
      ),
    ).toBe(false);
  });
});

// ── perturbMessages ─────────────────────────────────────────────────

describe("perturbMessages", () => {
  it("returns messages unchanged on first attempt", () => {
    const out = perturbMessages(baseMessages, 0);
    expect(out).toBe(baseMessages);
  });

  it("appends a retry hint on subsequent attempts", () => {
    const out = perturbMessages(baseMessages, 1);
    expect(out.length).toBe(baseMessages.length + 1);
    const last = out[out.length - 1]!;
    expect(last.role).toBe("system");
    expect(last.content).toContain("[retry 1]");
  });

  it("uses a loop-specific hint when reason is tool-loop-detected", () => {
    const out = perturbMessages(baseMessages, 2, "tool-loop-detected");
    const last = out[out.length - 1]!;
    expect(last.content).toContain("called the same tool repeatedly");
  });

  it("writes the hint in the instruction language of the session", () => {
    for (const reason of [undefined, "tool-loop-detected"] as const) {
      const hint = (locale?: string) =>
        String(
          perturbMessages(baseMessages, 1, reason, locale).at(-1)!.content,
        );
      // `[retry N]` and the tool name are markers; the sentences are Chinese.
      expect(hint("zh-CN")).toMatch(/^\[retry 1\] \p{Script=Han}/u);
      expect(
        hint("zh-CN").replace("[retry 1]", "").replace("runtime-done", ""),
      ).not.toMatch(/[A-Za-z]/);
      expect(hint("zh-Hant-TW")).toBe(hint("en-US"));
      expect(hint()).toBe(hint("en-US"));
    }
  });

  it("produces distinct byte strings per attempt (KV-cache break)", () => {
    const a = perturbMessages(baseMessages, 1)[baseMessages.length]!.content;
    const b = perturbMessages(baseMessages, 2)[baseMessages.length]!.content;
    expect(a).not.toBe(b);
  });
});

// ── callLLMWithRetry ────────────────────────────────────────────────

describe("callLLMWithRetry", () => {
  it("reports LLM-slot queue waits via onQueueWait", async () => {
    // Arrange — cap 1 with the slot held, so the call must queue.
    const { setLLMSlotCapForTests, acquireLLMSlot } =
      await import("../src/retry/llm-slots.js");
    setLLMSlotCapForTests(1);
    const holder = await acquireLLMSlot();
    setTimeout(() => holder.release(), 40);
    const llm = createScriptedLLM([
      { kind: "ok", response: okResponse("hello") },
    ]);
    const policy = buildRetryPolicy({ runtimeTimeoutMs: 10_000 });
    const waits: number[] = [];
    const emitter = makeEmitterSpy();

    // Act
    try {
      const res = await callLLMWithRetry({
        llm,
        messages: baseMessages,
        policy,
        deadline: Date.now() + 10_000,
        onQueueWait: (ms) => waits.push(ms),
        emitter,
      });

      // Assert — the queued call succeeded and reported its wait upward.
      expect(res.content).toBe("hello");
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThanOrEqual(30);
      expect(
        emitter.events.find((event) => event.type === "llm.calling")?.payload
          .queueWaitMs,
      ).toBe(waits[0]);
    } finally {
      setLLMSlotCapForTests(undefined);
    }
  });

  it("returns the response on the first successful attempt", async () => {
    const llm = createScriptedLLM([
      { kind: "ok", response: okResponse("hello") },
    ]);
    const policy = buildRetryPolicy({ runtimeTimeoutMs: 10_000 });

    const res = await callLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 10_000,
    });

    expect(res.content).toBe("hello");
    expect(llm.calls).toHaveLength(1);
  });

  it("retries on transient error and succeeds", async () => {
    const llm = createScriptedLLM([
      { kind: "throw", error: new Error("rate limited, try again") },
      { kind: "ok", response: okResponse("recovered") },
    ]);
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 10_000,
      maxRetries: 1,
    });
    const onRetry = vi.fn();

    const res = await callLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 10_000,
      onRetry,
    });

    expect(res.content).toBe("recovered");
    expect(llm.calls).toHaveLength(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]!.reason).toBe("transient-error");

    // Perturbation injected into retry messages.
    const retryMessages = llm.calls[1]!;
    expect(retryMessages.length).toBe(baseMessages.length + 1);
    expect(retryMessages[retryMessages.length - 1]!.role).toBe("system");
    expect(retryMessages[retryMessages.length - 1]!.content).toContain(
      "[retry",
    );
  });

  it("throws LLMRetryError after exhausting retries", async () => {
    const llm = createScriptedLLM([
      { kind: "throw", error: new Error("rate limited #1") },
      { kind: "throw", error: new Error("rate limited #2") },
    ]);
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 10_000,
      maxRetries: 1,
    });

    await expect(
      callLLMWithRetry({
        llm,
        messages: baseMessages,
        policy,
        deadline: Date.now() + 10_000,
      }),
    ).rejects.toThrow(LLMRetryError);

    expect(llm.calls).toHaveLength(2);
  });

  it("surfaces the cause message in the wrapper error", async () => {
    const llm = createScriptedLLM([
      { kind: "throw", error: new Error("upstream 502 timeout") },
    ]);
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 10_000,
      maxRetries: 0,
    });

    try {
      await callLLMWithRetry({
        llm,
        messages: baseMessages,
        policy,
        deadline: Date.now() + 10_000,
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LLMRetryError);
      expect((err as LLMRetryError).message).toContain("upstream 502 timeout");
    }
  });

  it("does not retry an unknown / non-transient error", async () => {
    const llm = createScriptedLLM([
      { kind: "throw", error: new Error("schema validation failed") },
      { kind: "ok", response: okResponse("should-not-be-used") },
    ]);
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 10_000,
      maxRetries: 3,
    });

    await expect(
      callLLMWithRetry({
        llm,
        messages: baseMessages,
        policy,
        deadline: Date.now() + 10_000,
      }),
    ).rejects.toThrow(LLMRetryError);

    expect(llm.calls).toHaveLength(1);
  });

  it("respects an already-past deadline", async () => {
    const llm = createScriptedLLM([{ kind: "ok", response: okResponse() }]);
    const policy = buildRetryPolicy({ runtimeTimeoutMs: 10_000 });

    await expect(
      callLLMWithRetry({
        llm,
        messages: baseMessages,
        policy,
        deadline: Date.now() - 1_000,
      }),
    ).rejects.toThrow(/deadline reached/i);
  });

  it("aborts a single call when it exceeds callTimeoutMs", async () => {
    // Use an adapter that ignores the abort signal's timeout until the caller
    // gives up and throws on its own. Simpler: adapter that just never
    // resolves until the signal aborts.
    const llm: LLMAdapter = {
      async generate(params): Promise<LLMResponse> {
        return new Promise((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => {
            reject(params.signal?.reason ?? new Error("aborted"));
          });
        });
      },
    };
    // The outer deadline is ten minutes away, so only the call timeout can
    // end this call before the test's own time limit does. No elapsed time
    // is measured: a bound on it fails on a loaded machine.
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 600_000,
      callTimeoutMs: 100,
      maxRetries: 0,
    });

    await expect(
      callLLMWithRetry({
        llm,
        messages: baseMessages,
        policy,
        deadline: Date.now() + 600_000,
      }),
    ).rejects.toMatchObject({
      name: "LLMRetryError",
      reason: "call-timeout",
      attempts: 1,
    });
  });
});

// ── streamLLMWithRetry ──────────────────────────────────────────────

describe("streamLLMWithRetry", () => {
  it("streams deltas to onDelta on the first attempt and collects text", async () => {
    const llm = createScriptedStreamLLM([
      {
        events: [
          { type: "text-delta", textDelta: "Hello " },
          { type: "text-delta", textDelta: "world" },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const policy = buildRetryPolicy({ runtimeTimeoutMs: 10_000 });
    const seen: string[] = [];

    const result = await streamLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 10_000,
      onDelta: (d) => {
        seen.push(d);
      },
    });

    expect(result.response.content).toBe("Hello world");
    expect(result.response.finishReason).toBe("stop");
    expect(seen).toEqual(["Hello ", "world"]);
    expect(result.attempt).toBe(0);
  });

  it("propagates provider usage from the done event (not hardcoded 0/0)", async () => {
    const llm = createScriptedStreamLLM([
      {
        events: [
          { type: "text-delta", textDelta: "hi" },
          {
            type: "done",
            finishReason: "stop",
            usage: { inputTokens: 42, outputTokens: 7 },
          },
        ],
      },
    ]);
    const policy = buildRetryPolicy({ runtimeTimeoutMs: 10_000 });

    const result = await streamLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 10_000,
    });

    expect(result.response.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  it("rejects partial content without retrying when the stream throws mid-flight", async () => {
    const llm = createScriptedStreamLLM([
      {
        events: [{ type: "text-delta", textDelta: "partial" }],
        throwAtEnd: new Error("upstream reset"),
      },
    ]);
    const policy = buildRetryPolicy({ runtimeTimeoutMs: 10_000 });

    await expect(
      streamLLMWithRetry({
        llm,
        messages: baseMessages,
        policy,
        deadline: Date.now() + 10_000,
      }),
    ).rejects.toThrow("upstream reset");
    expect(llm.attempts).toBe(1);
  });

  it("retries when the first attempt throws transiently with no content", async () => {
    const llm = createScriptedStreamLLM([
      { events: [], throwAtEnd: new Error("rate limited") },
      {
        events: [
          { type: "text-delta", textDelta: "second-try" },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 10_000,
      maxRetries: 1,
    });
    const onRetry = vi.fn();

    const result = await streamLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 10_000,
      onRetry,
    });

    expect(result.response.content).toBe("second-try");
    expect(result.attempt).toBe(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]!.reason).toBe("transient-error");
  });

  it("fires first-token timeout when the stream stalls before any token", async () => {
    const llm = createScriptedStreamLLM([
      {
        // A 1s delay with TTFB set to 50ms → TTFB fires first, aborts stream.
        events: [{ delay: 1000 }, { type: "text-delta", textDelta: "never" }],
      },
      {
        events: [
          { type: "text-delta", textDelta: "recovered" },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 10_000,
      firstTokenTimeoutMs: 50,
      maxRetries: 1,
    });
    const onRetry = vi.fn();

    const result = await streamLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 10_000,
      onRetry,
    });

    expect(result.response.content).toBe("recovered");
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]!.reason).toBe("first-token-timeout");
  });

  it("pauses the first-token timeout while the provider backs off a rate limit", async () => {
    const attempt = (statusCode: number) =>
      ({
        schemaVersion: 1,
        provider: "fixture",
        protocol: "openai-chat-v1",
        transportAttempt: 0,
        startedAt: new Date().toISOString(),
        durationMs: 1,
        statusCode,
      }) as LLMProviderRequest;
    // Like the transport's backoff, waits end early when the call aborts.
    const wait = (ms: number, signal: AbortSignal | undefined) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    const streamAfterBackoff = (stallAfterAnswerMs: number): LLMAdapter => ({
      generate: vi.fn(),
      async *stream(params) {
        params.onProviderRequest?.(attempt(429));
        // `retry-after` longer than the first-token timeout.
        await wait(150, params.signal);
        params.onProviderRequest?.(attempt(200));
        await wait(stallAfterAnswerMs, params.signal);
        yield { type: "text-delta", textDelta: "answered" };
        yield {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    const run = (llm: LLMAdapter) =>
      streamLLMWithRetry({
        llm,
        messages: baseMessages,
        // buildRetryPolicy floors the guard at 1s; set it directly to keep
        // the test fast.
        policy: {
          ...buildRetryPolicy({ runtimeTimeoutMs: 10_000, maxRetries: 0 }),
          firstTokenTimeoutMs: 50,
        },
        deadline: Date.now() + 10_000,
      });

    await expect(run(streamAfterBackoff(0))).resolves.toMatchObject({
      response: { content: "answered" },
    });
    // The guard restarts once an attempt is answered, so a real stall still
    // times out.
    await expect(run(streamAfterBackoff(150))).rejects.toThrow(
      "first-token timeout",
    );
  });

  it("does not forward deltas on retry attempts (avoid duplicate UX)", async () => {
    const llm = createScriptedStreamLLM([
      { events: [], throwAtEnd: new Error("rate limit") },
      {
        events: [
          { type: "text-delta", textDelta: "only-on-retry" },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 10_000,
      maxRetries: 1,
    });
    const seen: string[] = [];

    await streamLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 10_000,
      onDelta: (d) => {
        seen.push(d);
      },
    });

    // Nothing forwarded — first attempt threw with no content, retry does
    // not re-emit deltas so the user never sees duplicate text.
    expect(seen).toEqual([]);
  });

  it("falls back to generate() when no stream method is exposed", async () => {
    const llm: LLMAdapter = {
      async generate(): Promise<LLMResponse> {
        return okResponse("no-stream-rescue");
      },
    };
    const policy = buildRetryPolicy({ runtimeTimeoutMs: 10_000 });

    const result = await streamLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 10_000,
    });

    expect(result.response.content).toBe("no-stream-rescue");
  });
});

describe("streamLLMWithRetry silence limits", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** `chunks` text deltas, `gapMs` apart, then a normal finish. */
  function steadyStream(chunks: number, gapMs: number): StreamScript {
    return {
      events: [
        ...Array.from({ length: chunks }, () => [
          { delay: gapMs },
          { type: "text-delta" as const, textDelta: "x" },
        ]).flat(),
        { type: "done", finishReason: "stop" },
      ],
    };
  }

  it("does not cut off a stream that writes past callTimeoutMs, the runtime deadline and the default request deadline", async () => {
    // 10 minutes of output, never more than 30 s of silence.
    const llm = createScriptedStreamLLM([steadyStream(20, 30_000)]);
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 240_000,
      callTimeoutMs: 120_000,
      maxRetries: 1,
    });
    const streamTimes: number[] = [];
    const pending = streamLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 240_000,
      onStreamTime: (ms) => streamTimes.push(ms),
    });
    await vi.advanceTimersByTimeAsync(600_000);
    const result = await pending;

    expect(result.response.content).toBe("x".repeat(20));
    expect(llm.attempts).toBe(1);
    // From the first output (30 s) to the end (600 s).
    expect(streamTimes).toEqual([570_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a stream that goes silent after it started to write, without a retry", async () => {
    const llm = createScriptedStreamLLM([
      {
        events: [
          { type: "text-delta", textDelta: "partial" },
          { delay: 600_000 },
          { type: "text-delta", textDelta: "never" },
        ],
      },
      steadyStream(1, 0),
    ]);
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 240_000,
      idleTimeoutMs: 45_000,
      maxRetries: 1,
    });
    const onStreamTime = vi.fn();
    const pending = streamLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 240_000,
      onStreamTime,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "LLMRetryError",
      reason: "idle-timeout",
      hasPartialOutput: true,
    });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(llm.attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;

    expect(llm.attempts).toBe(1);
    expect(onStreamTime).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the idle wait with reasoning and tool-call output", async () => {
    const llm = createScriptedStreamLLM([
      {
        events: [
          { type: "reasoning-delta", reasoningDelta: "think" },
          { delay: 40_000 },
          { type: "reasoning-delta", reasoningDelta: "more" },
          { delay: 40_000 },
          { type: "tool-call", id: "c1", name: "lookup", arguments: "{}" },
          { delay: 40_000 },
          { type: "done", finishReason: "tool_calls" },
        ],
      },
    ]);
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 60_000,
      idleTimeoutMs: 45_000,
      maxRetries: 0,
    });
    const pending = streamLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 60_000,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await pending;

    expect(result.response.toolCalls).toHaveLength(1);
    expect(result.response.reasoningContent).toBe("thinkmore");
  });

  it("still bounds the wait for the first output by the runtime deadline", async () => {
    const llm = createScriptedStreamLLM([
      { events: [{ delay: 600_000 }, { type: "done", finishReason: "stop" }] },
    ]);
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 20_000,
      maxRetries: 0,
    });
    const pending = streamLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 20_000,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "LLMRetryError",
      reason: "first-token-timeout",
      hasPartialOutput: false,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── Trace emission tests ────────────────────────────────────────────

import { makeEmitterSpy } from "./_helpers/emitter-spy.js";

describe("callLLMWithRetry trace emissions", () => {
  it("emits llm.calling then llm.responded on success", async () => {
    const emitter = makeEmitterSpy();
    const stubResp: LLMResponse = {
      content: "hi",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const llm: LLMAdapter = {
      async generate() {
        return stubResp;
      },
    };

    await callLLMWithRetry({
      llm,
      model: "default",
      messages: [{ role: "user", content: "hi" }],
      policy: {
        maxRetries: 0,
        callTimeoutMs: 10_000,
        firstTokenTimeoutMs: 5_000,
        idleTimeoutMs: 30_000,
        loopDetectionThreshold: 3,
      },
      deadline: Date.now() + 30_000,
      emitter,
      runtimeId: "narrator/main",
      pluginId: "narrator",
    });

    expect(emitter.events.map((e) => e.type)).toEqual([
      "llm.calling",
      "llm.responded",
    ]);
    expect(emitter.events[0].payload).toMatchObject({
      runtimeId: "narrator/main",
      pluginId: "narrator",
      slot: "default",
      attempt: 0,
    });
    expect(emitter.events[1].payload).toMatchObject({
      text: "hi",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
      attempt: 0,
    });
  });

  it("emits llm.calling + llm.responded with error finishReason on throw", async () => {
    const emitter = makeEmitterSpy();
    const llm: LLMAdapter = {
      async generate() {
        throw new Error("boom");
      },
    };

    await expect(
      callLLMWithRetry({
        llm,
        model: "default",
        messages: [],
        policy: {
          maxRetries: 0,
          callTimeoutMs: 1_000,
          firstTokenTimeoutMs: 1_000,
          idleTimeoutMs: 30_000,
          loopDetectionThreshold: 3,
        },
        deadline: Date.now() + 5_000,
        emitter,
      }),
    ).rejects.toThrow();

    expect(emitter.events.map((e) => e.type)).toEqual([
      "llm.calling",
      "llm.responded",
    ]);
    expect(emitter.events[1].payload).toMatchObject({ finishReason: "error" });
  });

  it("records the final provider attempted inside a gateway fallback", async () => {
    const emitter = makeEmitterSpy();
    const llm: LLMAdapter = {
      async generate(params) {
        params.onTargetAttempt?.({ provider: "primary", model: "model-a" });
        params.onTargetAttempt?.({ provider: "backup", model: "model-b" });
        return {
          content: "ok",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    await callLLMWithRetry({
      llm,
      model: "story",
      resolvedModel: "model-a",
      provider: "primary",
      messages: [],
      policy: {
        maxRetries: 0,
        callTimeoutMs: 1_000,
        firstTokenTimeoutMs: 1_000,
        idleTimeoutMs: 30_000,
        loopDetectionThreshold: 3,
      },
      deadline: Date.now() + 5_000,
      emitter,
    });

    expect(emitter.events.map((event) => event.type)).toEqual([
      "llm.calling",
      "llm.responded",
    ]);
    expect(emitter.events[0]?.payload).toMatchObject({
      slot: "story",
      provider: "backup",
      model: "model-b",
    });
  });
});

describe("streamLLMWithRetry trace emissions", () => {
  it("emits llm.calling then llm.responded with streaming:true on success", async () => {
    const emitter = makeEmitterSpy();
    const llm: LLMAdapter = {
      async generate(): Promise<LLMResponse> {
        return {
          content: null,
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
      async *stream() {
        yield { type: "text-delta", textDelta: "hi" };
        yield { type: "done", finishReason: "stop" };
      },
    };

    await streamLLMWithRetry({
      llm,
      model: "default",
      messages: [{ role: "user", content: "ping" }],
      policy: {
        maxRetries: 0,
        callTimeoutMs: 10_000,
        firstTokenTimeoutMs: 5_000,
        idleTimeoutMs: 30_000,
        loopDetectionThreshold: 3,
      },
      deadline: Date.now() + 30_000,
      emitter,
      runtimeId: "narrator/main",
      pluginId: "narrator",
    });

    expect(emitter.events.map((e) => e.type)).toEqual([
      "llm.calling",
      "llm.responded",
    ]);
    expect(emitter.events[0].payload).toMatchObject({
      streaming: true,
      attempt: 0,
    });
    expect(emitter.events[1].payload).toMatchObject({
      streaming: true,
      text: "hi",
      finishReason: "stop",
      attempt: 0,
    });
  });

  it("emits llm.calling + llm.responded with error finishReason when stream throws", async () => {
    const emitter = makeEmitterSpy();
    const llm: LLMAdapter = {
      async generate(): Promise<LLMResponse> {
        return {
          content: null,
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
      async *stream() {
        throw new Error("fetch failed");
        // Unreachable, but required to satisfy the generator type.
        yield { type: "done", finishReason: "error" };
      },
    };

    await expect(
      streamLLMWithRetry({
        llm,
        model: "default",
        messages: [],
        policy: {
          maxRetries: 0,
          callTimeoutMs: 1_000,
          firstTokenTimeoutMs: 1_000,
          idleTimeoutMs: 30_000,
          loopDetectionThreshold: 3,
        },
        deadline: Date.now() + 5_000,
        emitter,
      }),
    ).rejects.toThrow();

    expect(emitter.events.map((e) => e.type)).toEqual([
      "llm.calling",
      "llm.responded",
    ]);
    expect(emitter.events[1].payload).toMatchObject({
      finishReason: "error",
      streaming: true,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(typeof emitter.events[1].payload.error).toBe("string");
  });

  it("records a gateway backup selected before the first stream event", async () => {
    const emitter = makeEmitterSpy();
    const llm: LLMAdapter = {
      async generate() {
        throw new Error("unused");
      },
      async *stream(params) {
        params.onTargetAttempt?.({ provider: "primary", model: "model-a" });
        params.onTargetAttempt?.({ provider: "backup", model: "model-b" });
        yield { type: "text-delta", textDelta: "ok" };
        yield { type: "done", finishReason: "stop" };
      },
    };

    await streamLLMWithRetry({
      llm,
      model: "story",
      resolvedModel: "model-a",
      provider: "primary",
      messages: [],
      policy: {
        maxRetries: 0,
        callTimeoutMs: 1_000,
        firstTokenTimeoutMs: 1_000,
        idleTimeoutMs: 30_000,
        loopDetectionThreshold: 3,
      },
      deadline: Date.now() + 5_000,
      emitter,
    });

    expect(emitter.events[0]?.payload).toMatchObject({
      provider: "backup",
      model: "model-b",
      streaming: true,
    });
  });
});

// ── computeAttemptBudget (R-19: no floor past the deadline) ─────────

describe("computeAttemptBudget", () => {
  const policy = {
    maxRetries: 1,
    callTimeoutMs: 10_000,
    firstTokenTimeoutMs: 30_000,
    idleTimeoutMs: 30_000,
    loopDetectionThreshold: 3,
  };

  it("returns 0 when the deadline has already passed", () => {
    expect(computeAttemptBudget(policy, Date.now() - 1)).toBe(0);
    expect(computeAttemptBudget(policy, Date.now() - 5_000)).toBe(0);
  });

  it("applies the 1s floor only while still before the deadline", () => {
    const budget = computeAttemptBudget(policy, Date.now() + 200);
    expect(budget).toBe(1_000);
  });

  it("caps the budget at callTimeoutMs", () => {
    const budget = computeAttemptBudget(policy, Date.now() + 60_000);
    expect(budget).toBe(policy.callTimeoutMs);
  });
});

// ── Silence warn noise ──────────────────────────────────────────────

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe("thinking stream activity", () => {
  it("counts reasoning as first output and retains its continuation without mixing it into narrative", async () => {
    vi.useFakeTimers();
    try {
      const providerContinuation = {
        protocol: "anthropic-messages-v1",
        model: "fixture",
        items: [{ type: "thinking", thinking: "summary", signature: "opaque" }],
      };
      const llm = createScriptedStreamLLM([
        {
          events: [
            { type: "reasoning-delta", reasoningDelta: "summary" },
            { delay: 100 },
            { type: "text-delta", textDelta: "answer" },
            {
              type: "done",
              finishReason: "stop",
              reasoningContent: "summary",
              providerContinuation,
            },
          ],
        },
      ]);
      const emitter = makeEmitterSpy();
      const onDelta = vi.fn();
      const pending = streamLLMWithRetry({
        llm,
        messages: baseMessages,
        policy: {
          maxRetries: 0,
          firstTokenTimeoutMs: 50,
          idleTimeoutMs: 30_000,
          callTimeoutMs: 500,
          loopDetectionThreshold: 3,
        },
        deadline: Date.now() + 1000,
        emitter,
        onDelta,
      });
      await vi.advanceTimersByTimeAsync(150);
      const result = await pending;
      expect(llm.attempts).toBe(1);
      expect(result.response).toMatchObject({
        content: "answer",
        reasoningContent: "summary",
        providerContinuation,
      });
      expect(onDelta.mock.calls).toEqual([["answer"]]);
      const trace = emitter.events.find(
        (event) => event.type === "llm.responded",
      )!.payload;
      expect(trace.reasoningContent).toBe("summary");
      expect(trace).not.toHaveProperty("providerContinuation");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("provider failure terminals", () => {
  const policy = buildRetryPolicy({ runtimeTimeoutMs: 10_000, maxRetries: 1 });

  it("rejects non-streaming error responses before success telemetry", async () => {
    const llm = createScriptedLLM([
      {
        kind: "ok",
        response: { ...okResponse("partial"), finishReason: "error" },
      },
      {
        kind: "ok",
        response: { ...okResponse("partial"), finishReason: "error" },
      },
    ]);
    const emitter = makeEmitterSpy();
    await expect(
      callLLMWithRetry({
        llm,
        messages: [],
        policy,
        deadline: Date.now() + 10_000,
        emitter,
      }),
    ).rejects.toThrow("model generation ended with an error");
    expect(
      emitter.events
        .filter((e) => e.type === "llm.responded")
        .every((e) => e.payload.finishReason === "error"),
    ).toBe(true);
  });

  it.each([
    [
      { type: "text-delta", textDelta: "partial" },
      { type: "done", finishReason: "error" },
    ],
    [
      { type: "tool-call", id: "call", name: "write", arguments: "{}" },
      { type: "done", finishReason: "error" },
    ],
    [{ type: "text-delta", textDelta: "partial" }],
    [{ type: "reasoning-delta", reasoningDelta: "partial reasoning" }],
  ] satisfies LLMStreamEvent[][])(
    "rejects incomplete or failed streams without retrying: %j",
    async (...events) => {
      const llm = createScriptedStreamLLM([{ events }]);
      const emitter = makeEmitterSpy();
      await expect(
        streamLLMWithRetry({
          llm,
          messages: [],
          policy,
          deadline: Date.now() + 10_000,
          emitter,
        }),
      ).rejects.toThrow("PROVIDER_ERROR");
      expect(llm.attempts).toBe(1);
      expect(
        emitter.events.filter((e) => e.type === "llm.responded"),
      ).toHaveLength(1);
      expect(emitter.events.at(-1)?.payload.finishReason).toBe("error");
    },
  );

  it("retries an explicit stream error before any output and accepts the successful retry", async () => {
    const llm = createScriptedStreamLLM([
      { events: [{ type: "done", finishReason: "error" }] },
      {
        events: [
          { type: "text-delta", textDelta: "complete" },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const result = await streamLLMWithRetry({
      llm,
      messages: [],
      policy,
      deadline: Date.now() + 10_000,
    });
    expect(result.response.content).toBe("complete");
    expect(llm.attempts).toBe(2);
  });
});

it("does not treat empty text deltas as partial output when retrying a stream", async () => {
  const llm = createScriptedStreamLLM([
    {
      events: [
        { type: "text-delta", textDelta: "" },
        { type: "done", finishReason: "error" },
      ],
    },
    {
      events: [
        { type: "text-delta", textDelta: "complete" },
        { type: "done", finishReason: "stop" },
      ],
    },
  ]);
  const result = await streamLLMWithRetry({
    llm,
    messages: [],
    policy: buildRetryPolicy({ runtimeTimeoutMs: 10_000, maxRetries: 1 }),
    deadline: Date.now() + 10_000,
  });
  expect(result.response.content).toBe("complete");
  expect(llm.attempts).toBe(2);
});
