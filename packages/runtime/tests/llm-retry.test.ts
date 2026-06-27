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
import type {
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  LLMStreamEvent,
} from "../src/llm/llm-adapter.js";

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

  it("produces distinct byte strings per attempt (KV-cache break)", () => {
    const a = perturbMessages(baseMessages, 1)[baseMessages.length]!.content;
    const b = perturbMessages(baseMessages, 2)[baseMessages.length]!.content;
    expect(a).not.toBe(b);
  });
});

// ── callLLMWithRetry ────────────────────────────────────────────────

describe("callLLMWithRetry", () => {
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
    const policy = buildRetryPolicy({
      runtimeTimeoutMs: 3_000,
      callTimeoutMs: 100,
      maxRetries: 0,
    });

    const start = Date.now();
    await expect(
      callLLMWithRetry({
        llm,
        messages: baseMessages,
        policy,
        deadline: Date.now() + 3_000,
      }),
    ).rejects.toThrow(LLMRetryError);
    // Call timeout kicked in, not the outer deadline.
    expect(Date.now() - start).toBeLessThan(2_000);
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

  it("salvages partial content when the stream throws mid-flight", async () => {
    const llm = createScriptedStreamLLM([
      {
        events: [{ type: "text-delta", textDelta: "partial" }],
        throwAtEnd: new Error("upstream reset"),
      },
    ]);
    const policy = buildRetryPolicy({ runtimeTimeoutMs: 10_000 });

    const result = await streamLLMWithRetry({
      llm,
      messages: baseMessages,
      policy,
      deadline: Date.now() + 10_000,
    });

    expect(result.response.content).toBe("partial");
    expect(result.response.finishReason).toBe("error");
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
});

// ── Silence warn noise ──────────────────────────────────────────────

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});
