import type { LookupAddress } from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/plugin-utils.js";

const lookupMock = vi.hoisted(() =>
  vi.fn<(hostname: string, options: object) => Promise<LookupAddress[]>>(),
);

vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

describe("fetchWithRetry Retry-After caps and deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    lookupMock.mockReset();
  });

  it("fails fast without sleeping when Retry-After exceeds MAX_RETRY_AFTER_MS", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "99999999" },
      }),
    );

    const response = await fetchWithRetry("https://api.example.test/v1/work", {
      maxRetries: 3,
    });

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("rate limited");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails fast when Retry-After-Ms exceeds MAX_RETRY_AFTER_MS", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("slow down", {
        status: 503,
        headers: { "retry-after-ms": "99999999" },
      }),
    );

    const response = await fetchWithRetry("https://api.example.test/v1/work", {
      maxRetries: 2,
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("slow down");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails fast when Retry-After exceeds the remaining request timeout", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("try later", {
        status: 429,
        headers: { "retry-after": "10" },
      }),
    );

    const response = await fetchWithRetry("https://api.example.test/v1/work", {
      maxRetries: 3,
      timeoutMs: 1_500,
    });

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("try later");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries when Retry-After fits within MAX_RETRY_AFTER_MS and timeoutMs", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("busy", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const pending = fetchWithRetry("https://api.example.test/v1/work", {
      maxRetries: 2,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
