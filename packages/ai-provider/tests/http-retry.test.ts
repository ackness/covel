/**
 * Retry wrapper for postJson().
 *
 * Verifies exponential-backoff retry on HTTP 429/5xx, Retry-After honoring,
 * AbortSignal propagation, and the COVEL_LLM_RETRY_DISABLED escape hatch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postJson, sleepWithAbort } from "../src/adapters/http.js";
import type { ProviderConfig } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────

interface MockResponseInit {
  readonly status: number;
  readonly retryAfter?: string;
  readonly body?: string;
}

/** Real streams expose cancellation through bodyUsed. */
function makeMockResponse(
  init: MockResponseInit,
): Response & { bodyDrained: boolean } {
  const headers = new Headers();
  if (init.retryAfter !== undefined)
    headers.set("retry-after", init.retryAfter);
  const response = new Response(init.body ?? "", {
    status: init.status,
    headers,
  });
  Object.defineProperty(response, "bodyDrained", {
    get: () => response.bodyUsed,
  });
  return response as Response & { bodyDrained: boolean };
}

const CONFIG: ProviderConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
};

// ── Setup ─────────────────────────────────────────────────────────

describe("postJson retry wrapper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Seed Math.random for deterministic jitter (doesn't matter much since
    // we run the clock, but keeps the tests reproducible).
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.COVEL_LLM_RETRY_DISABLED;
  });

  it("happy path: returns 200 on first try with one fetch call", async () => {
    const ok = makeMockResponse({ status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(ok);
    vi.stubGlobal("fetch", fetchMock);

    const result = await postJson(CONFIG, "/chat/completions", { a: 1 });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 then succeeds on second attempt", async () => {
    const rateLimited = makeMockResponse({ status: 429 });
    const ok = makeMockResponse({ status: 200 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const promise = postJson(CONFIG, "/chat/completions", { a: 1 });
    // Drain pending microtasks + advance any backoff timers.
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rateLimited.bodyDrained).toBe(true);
  });

  it("retries on 500 500 then succeeds (3 attempts)", async () => {
    const failA = makeMockResponse({ status: 500 });
    const failB = makeMockResponse({ status: 500 });
    const ok = makeMockResponse({ status: 200 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failA)
      .mockResolvedValueOnce(failB)
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const promise = postJson(CONFIG, "/chat/completions", { a: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(failA.bodyDrained).toBe(true);
    expect(failB.bodyDrained).toBe(true);
  });

  it("returns last 500 response when all retries are exhausted (4 attempts)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeMockResponse({ status: 500 }))
      .mockResolvedValueOnce(makeMockResponse({ status: 500 }))
      .mockResolvedValueOnce(makeMockResponse({ status: 500 }))
      .mockResolvedValueOnce(makeMockResponse({ status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = postJson(CONFIG, "/chat/completions", { a: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    // 1 original + 3 retries = 4 total attempts
    expect(result.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("honors Retry-After: 0 header (skips exponential schedule)", async () => {
    const rateLimited = makeMockResponse({ status: 429, retryAfter: "0" });
    const ok = makeMockResponse({ status: 200 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const promise = postJson(CONFIG, "/chat/completions", { a: 1 });
    // With Retry-After=0, the sleep is 0ms; still need to flush timers.
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts mid-backoff when signal is aborted", async () => {
    const rateLimited = makeMockResponse({ status: 429 });
    const fetchMock = vi.fn().mockResolvedValue(rateLimited);
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const promise = postJson(
      CONFIG,
      "/chat/completions",
      { a: 1 },
      controller.signal,
    );

    // Let the initial fetch + body drain resolve so we land inside sleepWithAbort.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();

    await expect(promise).rejects.toThrow();
    // Exactly one fetch fired before abort landed in the backoff wait.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels an unfinished error body before retrying", async () => {
    const cancel = vi.fn();
    const failure = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial error"));
        },
        cancel,
      }),
      { status: 503, headers: { "retry-after": "0" } },
    );
    const success = new Response("{}", { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(success),
    );
    const pending = postJson(CONFIG, "/chat/completions", {});
    await vi.runAllTimersAsync();
    expect(await pending).toBe(success);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps oversized timer waits abortable without clamping them to 1ms", async () => {
    const controller = new AbortController();
    const resolved = vi.fn();
    const pending = sleepWithAbort(2_147_483_700, controller.signal).then(
      resolved,
    );
    const rejected = expect(pending).rejects.toThrow("cancel long retry");
    await vi.advanceTimersByTimeAsync(2_147_483_648);
    expect(resolved).not.toHaveBeenCalled();
    controller.abort(new Error("cancel long retry"));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await expect(sleepWithAbort(Infinity)).rejects.toThrow(RangeError);
  });

  it("escape hatch COVEL_LLM_RETRY_DISABLED=1 bypasses retry entirely", async () => {
    process.env.COVEL_LLM_RETRY_DISABLED = "1";
    const rateLimited = makeMockResponse({ status: 429 });
    const fetchMock = vi.fn().mockResolvedValue(rateLimited);
    vi.stubGlobal("fetch", fetchMock);

    const result = await postJson(CONFIG, "/chat/completions", { a: 1 });

    expect(result.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry on non-retriable 4xx (e.g. 400)", async () => {
    const badRequest = makeMockResponse({ status: 400 });
    const fetchMock = vi.fn().mockResolvedValue(badRequest);
    vi.stubGlobal("fetch", fetchMock);

    const result = await postJson(CONFIG, "/chat/completions", { a: 1 });

    expect(result.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(badRequest.bodyDrained).toBe(false);
  });
});
