/**
 * Regression tests for the service-boundary error handling:
 *
 *  - `request()` used to throw a bare `Error`, so `RemoteDataService` could not
 *    tell 404 from 401/500 and collapsed everything to `null`. A hosted player
 *    with an expired owner token was told the session did not exist.
 *  - The SSE subscription retried every 4xx forever, leaving the UI stuck on
 *    "reconnecting" with no prompt to re-authenticate.
 *  - `/api/health` was parsed blindly, so a captive-portal HTML page surfaced
 *    as a bare SyntaxError far from the cause.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, isNotFound } from "../api/request.js";
import { fetchServerHealth } from "../api/health.js";
import { createSessionSubscription } from "../subscription.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("ApiError classification", () => {
  it("identifies a 404 as not-found and nothing else", () => {
    expect(isNotFound(new ApiError(404, "/api/worlds/x", ""))).toBe(true);
    expect(isNotFound(new ApiError(401, "/api/worlds/x", ""))).toBe(false);
    expect(isNotFound(new ApiError(500, "/api/worlds/x", ""))).toBe(false);
    expect(isNotFound(new Error("boom"))).toBe(false);
  });
});

describe("fetchServerHealth", () => {
  it("rejects a non-2xx probe instead of parsing it", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(503, {}));
    await expect(fetchServerHealth()).rejects.toThrow(/HTTP 503/);
  });

  it("rejects a 200 that is not a JSON object (captive portal HTML)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    } as unknown as Response);
    await expect(fetchServerHealth()).rejects.toThrow(/not a JSON object/);
  });

  it("returns the parsed body on success", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: "ok", bootId: "b1" }));
    await expect(fetchServerHealth()).resolves.toMatchObject({ bootId: "b1" });
  });
});

describe("SSE subscription retry policy", () => {
  it("keeps retrying an early 404 — local mode connects before syncToServer", async () => {
    // `startGameSession` dispatches SET_SESSION (which mounts the subscription)
    // several round-trips before `syncToServer` creates the session on the
    // server, so the opening attempts legitimately 404. Giving up on the first
    // one left the whole session with no plugin-data or suspension events.
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
      text: async () => "Session not found",
    } as Response);
    const states: string[] = [];

    const sub = createSessionSubscription("sess-1", {
      onStateChange: (s) => states.push(s),
    });
    await vi.waitFor(() => expect(states).toContain("reconnecting"));

    expect(states).not.toContain("closed");
    sub.close();
  });

  it("gives up once the client-error streak is exhausted", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Reconnect backoff is 1s doubling to 30s — drive it with fake timers
    // rather than making the suite wait ~15 seconds of real time.
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 401,
        ok: false,
        text: async () => "missing owner token",
      } as Response);
      const states: string[] = [];

      const sub = createSessionSubscription("sess-1", {
        onStateChange: (s) => states.push(s),
      });

      // 5 attempts total: the initial one plus four backoff waits.
      for (let i = 0; i < 5 && !states.includes("closed"); i++) {
        await vi.advanceTimersByTimeAsync(60_000);
      }

      expect(states).toContain("closed");
      expect(globalThis.fetch).toHaveBeenCalledTimes(5);
      sub.close();
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });

  it("keeps retrying a transient 503", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 503,
      ok: false,
      text: async () => "backend not ready",
    } as Response);
    const states: string[] = [];

    const sub = createSessionSubscription("sess-1", {
      onStateChange: (s) => states.push(s),
    });
    await vi.waitFor(() => expect(states).toContain("reconnecting"));

    expect(states).not.toContain("closed");
    sub.close();
  });
});
