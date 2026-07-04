import { describe, it, expect } from "vitest";
import type { PluginRuntimeGateway } from "@covel/plugin-loader";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import { withGatewayTrace } from "../src/function-runtime/gateway-trace.js";

const ctx = { sessionId: "s1", turnId: "t1", pluginId: "p1", runtimeId: "r1" };

function captureEmitter(): {
  emitter: TurnEmitter;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const emitter: TurnEmitter = {
    sessionId: "s1",
    turnId: "t1",
    async emit(type, payload) {
      events.push({ type, payload });
    },
  };
  return { emitter, events };
}

function makeGateway(
  overrides: Record<string, unknown> = {},
): PluginRuntimeGateway {
  return {
    generateText: async () => ({
      text: "",
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    generateObject: async () => ({
      object: {},
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    resolveSlot: () => null,
    ...overrides,
  } as PluginRuntimeGateway;
}

describe("withGatewayTrace (A2-P1-5)", () => {
  it("generateText emits gateway.calling then gateway.responded with finishReason/usage/durationMs", async () => {
    const { emitter, events } = captureEmitter();
    const gateway = makeGateway({
      generateText: async () => ({
        text: "hello",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const traced = withGatewayTrace(gateway, emitter, ctx);
    const result = await traced.generateText({ prompt: "hi", system: "sys" });

    expect(result.text).toBe("hello");
    expect(events.map((e) => e.type)).toEqual([
      "gateway.calling",
      "gateway.responded",
    ]);
    const responded = events[1]!.payload;
    expect(responded.method).toBe("generateText");
    expect(responded.finishReason).toBe("stop");
    expect(responded.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(typeof responded.durationMs).toBe("number");
    // Trace context is carried on every event.
    expect(responded.runtimeId).toBe("r1");
    expect(responded.pluginId).toBe("p1");
  });

  it("generateText emits gateway.failed and rethrows when the gateway throws", async () => {
    const { emitter, events } = captureEmitter();
    const gateway = makeGateway({
      generateText: async () => {
        throw new Error("provider down");
      },
    });

    const traced = withGatewayTrace(gateway, emitter, ctx);

    await expect(traced.generateText({ prompt: "hi" })).rejects.toThrow(
      "provider down",
    );
    expect(events.map((e) => e.type)).toEqual([
      "gateway.calling",
      "gateway.failed",
    ]);
    expect(events[1]!.payload.error).toBe("provider down");
    expect(typeof events[1]!.payload.durationMs).toBe("number");
  });

  it("generateObject emits calling/responded with method=generateObject", async () => {
    const { emitter, events } = captureEmitter();
    const gateway = makeGateway({
      generateObject: async () => ({
        object: { ok: true },
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2 },
      }),
    });

    const traced = withGatewayTrace(gateway, emitter, ctx);
    const r = await traced.generateObject({ schema: {}, prompt: "go" });

    expect(r.object).toEqual({ ok: true });
    expect(events.map((e) => e.type)).toEqual([
      "gateway.calling",
      "gateway.responded",
    ]);
    expect(events[0]!.payload.method).toBe("generateObject");
  });

  it("resolveSlot passes through and emits nothing (no provider call)", async () => {
    const { emitter, events } = captureEmitter();
    const slot = {
      presetId: "default",
      provider: "openai",
      protocol: "openai",
      model: "gpt",
      tag: "text",
      metadata: {},
    };
    const gateway = makeGateway({ resolveSlot: () => slot });

    const traced = withGatewayTrace(gateway, emitter, ctx);

    expect(traced.resolveSlot({ presetId: "default" })).toEqual(slot);
    expect(events).toHaveLength(0);
  });

  it("generateImage emits calling/responded with method=generateImage and imageCount, no usage", async () => {
    const { emitter, events } = captureEmitter();
    const gateway = makeGateway({
      generateImage: async () => ({
        images: [
          { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
        ],
        warnings: [],
      }),
    });

    const traced = withGatewayTrace(gateway, emitter, ctx);
    const result = await traced.generateImage!({ prompt: "a cat" });

    expect(result.images).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual([
      "gateway.calling",
      "gateway.responded",
    ]);
    const responded = events[1]!.payload;
    expect(responded.method).toBe("generateImage");
    expect(responded.imageCount).toBe(1);
    expect(responded.usage).toBeUndefined();
    expect(typeof responded.durationMs).toBe("number");
  });

  it("generateImage is absent from the traced facade when the source gateway has none", async () => {
    const { emitter } = captureEmitter();
    const traced = withGatewayTrace(makeGateway(), emitter, ctx);

    expect(traced.generateImage).toBeUndefined();
  });

  it("generateImage emits gateway.failed and rethrows when the gateway throws", async () => {
    const { emitter, events } = captureEmitter();
    const gateway = makeGateway({
      generateImage: async () => {
        throw new Error("image provider down");
      },
    });

    const traced = withGatewayTrace(gateway, emitter, ctx);

    await expect(traced.generateImage!({ prompt: "a cat" })).rejects.toThrow(
      "image provider down",
    );
    expect(events.map((e) => e.type)).toEqual([
      "gateway.calling",
      "gateway.failed",
    ]);
    expect(events[1]!.payload.error).toBe("image provider down");
  });

  it("gateway.calling carries only prompt shape (messageCount/promptChars), never raw text", async () => {
    const { emitter, events } = captureEmitter();
    const traced = withGatewayTrace(makeGateway(), emitter, ctx);

    await traced.generateText({
      system: "secret-sys",
      prompt: "secret-prompt",
      presetId: "fast",
    });

    const calling = events[0]!.payload;
    expect(calling.method).toBe("generateText");
    expect(calling.presetId).toBe("fast");
    expect(calling.messageCount).toBe(2);
    expect(calling.promptChars).toBe(
      "secret-sys".length + "secret-prompt".length,
    );
    // PII guard: no raw prompt/system text anywhere in the payload.
    const serialized = JSON.stringify(calling);
    expect(serialized).not.toContain("secret-sys");
    expect(serialized).not.toContain("secret-prompt");
  });
});
