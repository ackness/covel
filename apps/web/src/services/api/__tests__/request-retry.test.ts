import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiResponseError, request } from "../request.js";
import * as toastChannel from "@/lib/toast-channel.js";

/**
 * `request()` retries idempotent GETs on a boot-race / transient gateway
 * failure (dev proxy 503 while the runtime server boots, or ECONNREFUSED
 * socket reset), so the first page load doesn't need a manual reload. Non-GET
 * requests must NOT retry (avoid double-submit).
 */

const okRes = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const errRes = (status: number) => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => "unavailable",
});

describe("request() boot-race retry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries a GET on 503, then resolves", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errRes(503))
      .mockResolvedValueOnce(okRes({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = request<{ ok: boolean }>("/api/presets");
    await vi.advanceTimersByTimeAsync(300); // clear the 250ms first backoff
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a GET on a transport error (ECONNREFUSED), then resolves", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3001"))
      .mockResolvedValueOnce(okRes({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = request<{ items: unknown[] }>("/api/worlds", {
      silentErrors: true,
    });
    await vi.advanceTimersByTimeAsync(300);
    await expect(promise).resolves.toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["GET", "POST"])(
    "does not retry or toast an aborted %s",
    async (method) => {
      const abortError = new DOMException("aborted", "AbortError");
      const fetchMock = vi.fn().mockRejectedValue(abortError);
      const emitToast = vi.spyOn(toastChannel, "emitToast");
      vi.stubGlobal("fetch", fetchMock);

      await expect(request("/api/worlds", { method })).rejects.toBe(abortError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(emitToast).not.toHaveBeenCalled();
    },
  );

  it.each([200, 500])(
    "preserves cancellation while reading a %s response body without a toast",
    async (status) => {
      const abortError = new DOMException("aborted", "AbortError");
      const fetchMock = vi.fn().mockResolvedValue({
        ...okRes({}),
        ok: status === 200,
        status,
        json: vi.fn().mockRejectedValue(abortError),
        text: vi.fn().mockRejectedValue(abortError),
      });
      const emitToast = vi.spyOn(toastChannel, "emitToast");
      vi.stubGlobal("fetch", fetchMock);

      await expect(request("/api/worlds")).rejects.toBe(abortError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(emitToast).not.toHaveBeenCalled();
    },
  );

  it("still reports an actual network failure", async () => {
    const failure = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    const emitToast = vi.spyOn(toastChannel, "emitToast");

    await expect(request("/api/worlds", { method: "POST" })).rejects.toBe(
      failure,
    );
    expect(emitToast).toHaveBeenCalledWith(
      "error",
      expect.any(String),
      expect.stringContaining("Failed to fetch"),
    );
  });

  it("does NOT retry a POST (avoids double-submit)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errRes(503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      request("/api/sessions", {
        method: "POST",
        body: "{}",
        silentErrors: true,
      }),
    ).rejects.toThrow("API 503");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a GET on a real app error (500)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errRes(500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      request("/api/worlds", { silentErrors: true }),
    ).rejects.toThrow("API 500");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets long-lived clients own their retry policy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errRes(503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      request("/api/events/stream", {
        retry: false,
        silentErrors: true,
      }),
    ).rejects.toThrow("API 503");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sets JSON content type only for JSON-string bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okRes({ ok: true }))
      .mockResolvedValueOnce(okRes({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await request("/api/worlds");
    await request("/api/install/plugin", {
      method: "POST",
      body: new FormData(),
    });

    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Content-Type"),
    ).toBeNull();
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Content-Type"),
    ).toBeNull();
  });

  it("accepts Headers instances and validates successful responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okRes({ ok: "wrong" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      request("/api/example", {
        headers: new Headers({ "X-Custom": "value" }),
        silentErrors: true,
        schema: z.object({ ok: z.literal(true) }),
      }),
    ).rejects.toBeInstanceOf(ApiResponseError);
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Custom"),
    ).toBe("value");
  });
});
