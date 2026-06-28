import { describe, it, expect } from "vitest";
import type { PluginRuntimeUtils } from "@covel/plugin-loader";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import { withUtilsTrace } from "../src/function-runtime/utils-trace.js";

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

function makeUtils(
  overrides: Record<string, unknown> = {},
): PluginRuntimeUtils {
  return {
    validateBaseUrl: () => ({ ok: true }),
    fetchWithRetry: async () => new Response("ok", { status: 200 }),
    ...overrides,
  } as PluginRuntimeUtils;
}

describe("withUtilsTrace (A2-P1-5 follow-up)", () => {
  it("emits utils.fetch.calling then responded with host/method/status/durationMs", async () => {
    const { emitter, events } = captureEmitter();
    const utils = makeUtils({
      fetchWithRetry: async () => new Response("body", { status: 201 }),
    });

    const traced = withUtilsTrace(utils, emitter, ctx);
    const res = await traced.fetchWithRetry(
      "https://dashscope.aliyuncs.com/api/v1/x?key=SECRET",
      { method: "POST" },
    );

    expect(res.status).toBe(201);
    expect(events.map((e) => e.type)).toEqual([
      "utils.fetch.calling",
      "utils.fetch.responded",
    ]);
    const responded = events[1]!.payload;
    expect(responded.host).toBe("dashscope.aliyuncs.com");
    expect(responded.method).toBe("POST");
    expect(responded.status).toBe(201);
    expect(responded.ok).toBe(true);
    expect(typeof responded.durationMs).toBe("number");
    expect(responded.runtimeId).toBe("r1");
  });

  it("emits utils.fetch.failed and rethrows when fetch throws", async () => {
    const { emitter, events } = captureEmitter();
    const utils = makeUtils({
      fetchWithRetry: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const traced = withUtilsTrace(utils, emitter, ctx);

    await expect(traced.fetchWithRetry("https://host.test/x")).rejects.toThrow(
      "ECONNREFUSED",
    );
    expect(events.map((e) => e.type)).toEqual([
      "utils.fetch.calling",
      "utils.fetch.failed",
    ]);
    expect(events[1]!.payload.error).toBe("ECONNREFUSED");
    expect(typeof events[1]!.payload.durationMs).toBe("number");
  });

  it("validateBaseUrl passes through and emits nothing", async () => {
    const { emitter, events } = captureEmitter();
    const utils = makeUtils({
      validateBaseUrl: () => ({ ok: false, reason: "blocked" }),
    });

    const traced = withUtilsTrace(utils, emitter, ctx);

    expect(traced.validateBaseUrl("http://10.0.0.1")).toEqual({
      ok: false,
      reason: "blocked",
    });
    expect(events).toHaveLength(0);
  });

  it("calling carries only host — never the full URL / query / api key (PII guard)", async () => {
    const { emitter, events } = captureEmitter();
    const traced = withUtilsTrace(makeUtils(), emitter, ctx);

    await traced.fetchWithRetry(
      "https://api.provider.test/v1/images?api_key=sk-SECRET-123&prompt=topsecret",
    );

    expect(events[0]!.payload.host).toBe("api.provider.test");
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("sk-SECRET-123");
    expect(serialized).not.toContain("topsecret");
    expect(serialized).not.toContain("/v1/images");
  });

  it("defaults method to GET and labels an invalid URL safely", async () => {
    const { emitter, events } = captureEmitter();
    const traced = withUtilsTrace(makeUtils(), emitter, ctx);

    await traced.fetchWithRetry("not-a-url");

    expect(events[0]!.payload.method).toBe("GET");
    expect(events[0]!.payload.host).toBe("(invalid-url)");
  });
});
