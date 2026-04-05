import { describe, it, expect } from "vitest";
import { createRuntimeExecutor } from "../src/executor.js";
import type { GatewayLike } from "../src/executor.js";
import type { RuntimeContextView } from "@covel/shared";
import type { StreamEvent } from "@covel/ai-provider";

function makeGateway(overrides?: Partial<GatewayLike>): GatewayLike {
  return {
    async generateText() {
      return {
        text: "generated text",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
    async *streamText() {
      yield { type: "text-delta" as const, textDelta: "hello" };
      yield {
        type: "done" as const,
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 3 },
      };
    },
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<RuntimeContextView> = {}
): RuntimeContextView {
  return {
    run: { runId: "r1", branchId: "b1", turnId: "t1" },
    locale: "zh-CN",
    runtime: {
      runtimeId: "rt-1",
      pluginId: "p-1",
      kind: "story",
      phase: "story",
      allowedTools: [],
      providerTag: "text",
    },
    ...overrides,
  };
}

describe("runtime-executor", () => {
  it("should NOT pass providerTag as presetId when no explicit presetId is given", async () => {
    let capturedPresetId: string | undefined = "SENTINEL";
    const gateway = makeGateway({
      async *streamText(input) {
        capturedPresetId = input.presetId;
        yield { type: "done" as const, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });

    const executor = createRuntimeExecutor(gateway);
    for await (const _ of executor.stream({ context: makeContext() })) {
      // consume
    }

    // providerTag ("text") must NOT leak into presetId
    expect(capturedPresetId).toBeUndefined();
  });

  it("should pass explicit presetId when provided", async () => {
    let capturedPresetId: string | undefined;
    const gateway = makeGateway({
      async *streamText(input) {
        capturedPresetId = input.presetId;
        yield { type: "done" as const, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });

    const executor = createRuntimeExecutor(gateway);
    for await (const _ of executor.stream({ context: makeContext(), presetId: "my-preset" })) {
      // consume
    }

    expect(capturedPresetId).toBe("my-preset");
  });

  it("streams events from gateway", async () => {
    const executor = createRuntimeExecutor(makeGateway());
    const events: StreamEvent[] = [];

    for await (const event of executor.stream({
      context: makeContext(),
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text-delta", textDelta: "hello" });
    expect(events[1]).toMatchObject({ type: "done" });
  });

  it("passes apiKeys and traceId to gateway via stream", async () => {
    let capturedOptions: any;
    const gateway = makeGateway({
      async *streamText(input, options) {
        capturedOptions = options;
        yield {
          type: "done" as const,
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const executor = createRuntimeExecutor(gateway);
    // Consume the stream to trigger the call
    for await (const _event of executor.stream({
      context: makeContext(),
      apiKeys: { deepseek: "sk-123" },
      traceId: "trace-abc",
    })) {
      // consume
    }

    expect(capturedOptions.apiKeys).toEqual({ deepseek: "sk-123" });
    expect(capturedOptions.traceId).toBe("trace-abc");
  });
});
