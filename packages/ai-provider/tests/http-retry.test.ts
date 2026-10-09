/**
 * Retry wrapper for postJson().
 *
 * Verifies exponential-backoff retry on HTTP 429/5xx, Retry-After honoring,
 * AbortSignal propagation, and the COVEL_LLM_RETRY_DISABLED escape hatch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRetryAfterMs,
  postJson,
  sleepWithAbort,
} from "../src/adapters/http.js";
import { parseRetryDelayMs } from "../src/adapters/http/retry.js";
import { createLlmRequestBudget } from "@covel/shared";
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

  it.each([429, 503])(
    "does not resend an irreversible generation after HTTP %s",
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(makeMockResponse({ status }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await postJson(
        CONFIG,
        "/images/generations",
        {},
        undefined,
        undefined,
        { retry: false },
      );
      expect(result.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not resend an irreversible generation after an ambiguous connection drop", async () => {
    const failure = new TypeError("fetch failed", {
      cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    });
    const fetchMock = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      postJson(CONFIG, "/images/generations", {}, undefined, undefined, {
        retry: false,
      }),
    ).rejects.toThrow("ECONNRESET");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("sends the request again when the connection was refused or dropped", async () => {
    // What Undici throws when a local endpoint restarts.
    const dropped = (code: string) =>
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error(`connect ${code}`), { code }),
      });
    const ok = makeMockResponse({ status: 200 });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(dropped("ECONNREFUSED"))
      .mockRejectedValueOnce(dropped("ECONNRESET"))
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const promise = postJson(CONFIG, "/chat/completions", { a: 1 });
    await vi.runAllTimersAsync();
    expect((await promise).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up on a connection that stays down, and counts both kinds of retry together", async () => {
    const refused = () =>
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      });
    const down = vi.fn().mockImplementation(async () => {
      throw refused();
    });
    vi.stubGlobal("fetch", down);
    const failing = postJson(CONFIG, "/chat/completions", { a: 1 });
    const rejected = expect(failing).rejects.toThrow("fetch failed");
    await vi.runAllTimersAsync();
    await rejected;
    // 1 original + 3 retries.
    expect(down).toHaveBeenCalledTimes(4);

    const mixed = vi
      .fn()
      .mockResolvedValueOnce(makeMockResponse({ status: 500 }))
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce(makeMockResponse({ status: 500 }))
      .mockResolvedValueOnce(makeMockResponse({ status: 500 }))
      .mockResolvedValueOnce(makeMockResponse({ status: 200 }));
    vi.stubGlobal("fetch", mixed);
    const promise = postJson(CONFIG, "/chat/completions", { a: 1 });
    await vi.runAllTimersAsync();
    expect((await promise).status).toBe(500);
    expect(mixed).toHaveBeenCalledTimes(4);

    // The retry a response asked for is counted before the connection drops.
    const thenDown = vi
      .fn()
      .mockResolvedValueOnce(makeMockResponse({ status: 500 }))
      .mockImplementation(async () => {
        throw refused();
      });
    vi.stubGlobal("fetch", thenDown);
    const dropping = postJson(CONFIG, "/chat/completions", { a: 1 });
    const dropped = expect(dropping).rejects.toThrow("fetch failed");
    await vi.runAllTimersAsync();
    await dropped;
    expect(thenDown).toHaveBeenCalledTimes(4);
  });

  it("does not retry an error that is no dropped connection", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("Provider error: blocked address"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      postJson(CONFIG, "/chat/completions", { a: 1 }),
    ).rejects.toThrow("blocked address");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("honors Retry-After HTTP dates and clamps dates in the past", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeMockResponse({
          status: 429,
          retryAfter: "Thu, 01 Jan 2026 00:00:02 GMT",
        }),
      )
      .mockResolvedValueOnce(makeMockResponse({ status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = postJson(CONFIG, "/chat/completions", {});
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(200);
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:00 GMT")).toBe(0);
    expect(parseRetryAfterMs("invalid")).toBeNull();
    expect(parseRetryAfterMs("0.5")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the answer at once when the wait asked for outlasts the call", async () => {
    const fetchMock = vi.fn(async () =>
      makeMockResponse({ status: 429, retryAfter: "120", body: "slow down" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // Over the budget's deadline, and over the longest wait of any call.
    for (const config of [
      { ...CONFIG, requestBudget: createLlmRequestBudget({ timeoutMs: 50 }) },
      CONFIG,
    ]) {
      const response = await postJson(config, "/chat/completions", {});
      expect(response.status).toBe(429);
      // The body is still there for the adapter to read the provider's reason.
      expect(await response.text()).toBe("slow down");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits out a Retry-After that fits the budget and stops at its deadline", async () => {
    const fetchMock = vi.fn(async () =>
      makeMockResponse({ status: 429, retryAfter: "1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = postJson(
      {
        ...CONFIG,
        requestBudget: createLlmRequestBudget({ timeoutMs: 1500 }),
      },
      "/chat/completions",
      {},
    );
    const settled = pending.then(
      (response) => response.status,
      (error: { code?: string }) => error.code,
    );
    await vi.advanceTimersByTimeAsync(1500);
    // One wait fits; the second would pass the deadline, so the 429 returns.
    expect(await settled).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads retry-after-ms before retry-after", async () => {
    const headers = new Headers({
      "retry-after-ms": "250",
      "retry-after": "9",
    });
    expect(parseRetryDelayMs(headers)).toBe(250);
    expect(parseRetryDelayMs(new Headers({ "retry-after": "9" }))).toBe(9000);
    expect(
      parseRetryDelayMs(new Headers({ "retry-after-ms": "soon" })),
    ).toBeNull();
    expect(parseRetryDelayMs(new Headers())).toBeNull();
  });

  it.each([
    [408, undefined, 2],
    [409, undefined, 2],
    [400, undefined, 1],
    [400, "true", 2],
    [503, "false", 1],
  ])(
    "sends a %i with x-should-retry %s %i time(s)",
    async (status, instruction, calls) => {
      const failure = new Response("", {
        status,
        headers: instruction ? { "x-should-retry": instruction } : {},
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(failure)
        .mockResolvedValue(makeMockResponse({ status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const pending = postJson(CONFIG, "/chat/completions", {});
      await vi.runAllTimersAsync();
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    },
  );

  it("sends a request once when the caller turns transport retries off", async () => {
    const fetchMock = vi.fn(async () => makeMockResponse({ status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await postJson(
      { ...CONFIG, transportRetry: false },
      "/chat/completions",
      {},
    );
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledOnce();
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
