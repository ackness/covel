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
      providerBinding: "default",
    },
    ...overrides,
  };
}

describe("runtime-executor", () => {
  it("executes a non-streaming generation", async () => {
    const executor = createRuntimeExecutor(makeGateway());
    const result = await executor.execute({
      context: makeContext(),
      instructions: "You are a storyteller.",
    });

    expect(result.text).toBe("generated text");
    expect(result.steps).toBe(1);
    expect(result.usage.inputTokens).toBe(10);
  });

  it("resolves preset from providerBinding", async () => {
    let capturedPresetId: string | undefined;
    const gateway = makeGateway({
      async generateText(input) {
        capturedPresetId = input.presetId;
        return {
          text: "ok",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const executor = createRuntimeExecutor(gateway);
    await executor.execute({
      context: makeContext({
        runtime: {
          runtimeId: "rt",
          pluginId: "p",
          kind: "story",
          phase: "story",
          allowedTools: [],
          providerBinding: "my-preset",
        },
      }),
    });

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

  it("passes apiKeys and traceId to gateway", async () => {
    let capturedOptions: any;
    const gateway = makeGateway({
      async generateText(input, options) {
        capturedOptions = options;
        return {
          text: "ok",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const executor = createRuntimeExecutor(gateway);
    await executor.execute({
      context: makeContext(),
      apiKeys: { deepseek: "sk-123" },
      traceId: "trace-abc",
    });

    expect(capturedOptions.apiKeys).toEqual({ deepseek: "sk-123" });
    expect(capturedOptions.traceId).toBe("trace-abc");
  });
});
