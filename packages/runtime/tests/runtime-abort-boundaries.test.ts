import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginRuntimeGateway,
  PluginRuntimeUtils,
} from "@covel/plugin-loader";
import {
  withDefaultGatewaySignal,
  withDefaultUtilsSignal,
  withStalledCallRetry,
} from "../src/function-runtime/runtime-abort-boundaries.js";

function gatewayWithGenerateText(
  generateText: PluginRuntimeGateway["generateText"],
): PluginRuntimeGateway {
  return {
    generateText,
    generateObject: vi.fn(),
    resolveSlot: vi.fn(() => null),
  };
}

describe("runtime abort boundaries", () => {
  it("applies the runtime signal when gateway callers omit one", async () => {
    const runtimeAbort = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const gateway = gatewayWithGenerateText(async (input) => {
      receivedSignal = input.signal;
      return {
        text: "ok",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });

    await withDefaultGatewaySignal(gateway, runtimeAbort.signal).generateText({
      prompt: "hello",
    });
    expect(receivedSignal?.aborted).toBe(false);

    runtimeAbort.abort(new Error("runtime deadline"));
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toEqual(new Error("runtime deadline"));
  });

  it("combines explicit and runtime signals for plugin HTTP requests", async () => {
    const runtimeAbort = new AbortController();
    const requestAbort = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const utils: PluginRuntimeUtils = {
      validateBaseUrl: () => ({ ok: true }),
      fetchWithRetry: vi.fn(async (_input, init) => {
        receivedSignal = init?.signal;
        return new Response(null, { status: 204 });
      }),
    };

    await withDefaultUtilsSignal(utils, runtimeAbort.signal).fetchWithRetry(
      "https://example.com",
      {
        signal: requestAbort.signal,
      },
    );
    expect(receivedSignal?.aborted).toBe(false);

    requestAbort.abort(new Error("request cancelled"));
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toEqual(new Error("request cancelled"));
  });
});

describe("stalled text calls of a function runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const reply = {
    text: "ok",
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  /** A model that never answers its first `stalls` requests, then takes `answerMs`. */
  function stallingGateway(stalls: number, answerMs: number) {
    const calls: number[] = [];
    const startedAt = Date.now();
    const gateway = gatewayWithGenerateText(
      (input) =>
        new Promise((resolve, reject) => {
          calls.push(Date.now() - startedAt);
          input.signal?.addEventListener("abort", () =>
            reject(input.signal!.reason),
          );
          if (calls.length > stalls) setTimeout(() => resolve(reply), answerMs);
        }),
    );
    return { gateway, calls };
  }
  const within = (gateway: PluginRuntimeGateway, timeoutMs: number) =>
    withStalledCallRetry(gateway, {
      deadline: Date.now() + timeoutMs,
      runtimeId: "fixture/extract",
    });

  it("sends a call that got no answer again while the runtime has time", async () => {
    const { gateway, calls } = stallingGateway(1, 3_000);
    const pending = within(gateway, 120_000).generateText({ prompt: "p" });
    await vi.advanceTimersByTimeAsync(63_000);

    await expect(pending).resolves.toEqual(reply);
    expect(calls).toEqual([0, 60_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not cut a slow answer short when the runtime has no time for a second attempt", async () => {
    const { gateway, calls } = stallingGateway(0, 55_000);
    const pending = within(gateway, 60_000).generateText({ prompt: "p" });
    await vi.advanceTimersByTimeAsync(55_000);

    await expect(pending).resolves.toEqual(reply);
    expect(calls).toEqual([0]);
  });

  it("leaves the second attempt to the runtime's own limit", async () => {
    const runtime = new AbortController();
    const { gateway, calls } = stallingGateway(2, 0);
    const pending = within(gateway, 120_000).generateText({
      prompt: "p",
      signal: runtime.signal,
    });
    const rejected = expect(pending).rejects.toThrow("runtime deadline");
    await vi.advanceTimersByTimeAsync(119_000);
    expect(calls).toEqual([0, 60_000]);
    runtime.abort(new Error("runtime deadline"));

    await rejected;
  });

  it("does not repeat a call the gateway failed or the caller aborted", async () => {
    const failing = gatewayWithGenerateText(
      vi.fn().mockRejectedValue(new Error("HTTP 401")),
    );
    await expect(
      within(failing, 120_000).generateText({ prompt: "p" }),
    ).rejects.toThrow("HTTP 401");
    expect(failing.generateText).toHaveBeenCalledTimes(1);

    const caller = new AbortController();
    const { gateway, calls } = stallingGateway(2, 0);
    const pending = within(gateway, 120_000).generateText({
      prompt: "p",
      signal: caller.signal,
    });
    const rejected = expect(pending).rejects.toThrow("player stopped");
    caller.abort(new Error("player stopped"));
    await rejected;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toEqual([0]);
  });
});
