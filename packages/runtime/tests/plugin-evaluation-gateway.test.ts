import { expect, it, vi } from "vitest";
import { createPluginRuntimeGateway } from "../src/function-runtime/plugin-runtime-gateway.js";
import { withDefaultGatewaySignal } from "../src/function-runtime/runtime-abort-boundaries.js";
import { withGatewayTrace } from "../src/function-runtime/gateway-trace.js";

it("threads evaluation role, request credentials, overrides and abort signals through the plugin bridge without tracing state", async () => {
  const evaluate = vi.fn(async () => ({
    model: "fixture/jev",
    answers: { allowed: { type: "boolean", probability: 0.7 } },
    usage: { inputTokens: 17, outputTokens: 0 },
  }));
  const options = {
    apiKeys: { fixture: "test-only-placeholder" },
    traceId: "trace-1",
    slotOverrides: { bindings: { evaluation: "fixture-model" } },
  };
  const gateway = createPluginRuntimeGateway(
    {
      generateText: vi.fn(),
      generateObject: vi.fn(),
      resolveSlot: vi.fn(),
      evaluate,
    },
    options,
  );
  const runtime = new AbortController();
  const caller = new AbortController();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const traced = withGatewayTrace(
    withDefaultGatewaySignal(gateway, runtime.signal),
    {
      sessionId: "test",
      turnId: "turn",
      emit: async (type, payload) => {
        events.push({ type, payload });
      },
    },
    {
      sessionId: "test",
      turnId: "turn",
      pluginId: "consumer",
      runtimeId: "consumer/evaluate",
    },
  );
  const state = "private story text";
  await traced.evaluate!({
    presetId: "intent",
    state,
    questions: {
      allowed: { type: "boolean", instructions: "private criterion" },
    },
    signal: caller.signal,
  });
  expect(evaluate).toHaveBeenCalledWith(
    expect.objectContaining({ presetId: "intent", state }),
    expect.objectContaining(options),
  );
  const signal = evaluate.mock.calls[0]![1].signal as AbortSignal;
  runtime.abort(new Error("runtime expired"));
  expect(signal.aborted).toBe(true);
  expect(events.map((event) => event.type)).toEqual([
    "gateway.calling",
    "gateway.responded",
  ]);
  expect(events[0]!.payload).toMatchObject({
    method: "evaluate",
    questionCount: 1,
  });
  expect(events[1]!.payload).toMatchObject({
    usage: { inputTokens: 17, outputTokens: 0 },
  });
  expect(JSON.stringify(events)).not.toContain(state);
  expect(JSON.stringify(events)).not.toContain("private criterion");
  expect(JSON.stringify(events)).not.toContain("test-only-placeholder");
});
