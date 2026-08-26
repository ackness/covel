import { describe, expect, it, vi } from "vitest";
import type {
  PluginRuntimeGateway,
  PluginRuntimeUtils,
} from "@covel/plugin-loader";
import {
  withDefaultGatewaySignal,
  withDefaultUtilsSignal,
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
