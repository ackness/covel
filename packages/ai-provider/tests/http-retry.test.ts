/**
 * S1-T3: Retry wrapper for postJson().
 *
 * Verifies exponential-backoff retry on HTTP 429/5xx, Retry-After honoring,
 * AbortSignal propagation, and the COVEL_LLM_RETRY_DISABLED escape hatch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postJson } from "../src/adapters/http.js";
import type { ProviderConfig } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────

interface MockResponseInit {
	readonly status: number;
	readonly retryAfter?: string;
	readonly body?: string;
}

/**
 * Build a mock Response-like object. We can't use the real Response since
 * we need to track whether arrayBuffer() has been called to confirm body drain.
 */
function makeMockResponse(
	init: MockResponseInit,
): Response & { bodyDrained: boolean } {
	const headers = new Headers();
	if (init.retryAfter !== undefined)
		headers.set("retry-after", init.retryAfter);

	const mock = {
		ok: init.status >= 200 && init.status < 300,
		status: init.status,
		statusText: `HTTP ${init.status}`,
		headers,
		bodyDrained: false,
		async arrayBuffer() {
			this.bodyDrained = true;
			return new ArrayBuffer(0);
		},
		async text() {
			return init.body ?? "";
		},
		async json() {
			return init.body ? JSON.parse(init.body) : {};
		},
	};
	return mock as unknown as Response & { bodyDrained: boolean };
}

const CONFIG: ProviderConfig = {
	baseUrl: "https://api.openai.com/v1",
	apiKey: "test-key",
};

// ── Setup ─────────────────────────────────────────────────────────

describe("postJson retry wrapper (S1-T3)", () => {
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
