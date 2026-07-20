/**
 * function-runtime trace coverage (A2-P1-5).
 *
 * Function runtimes used to be near-invisible in the trace timeline: nothing
 * between runtime.started/completed, zero rows for ctx.gateway provider calls,
 * and a missing-handler left a hanging runtime.started. These tests pin the new
 * function.executing / function.completed / gateway.* emissions, the
 * missing-handler terminal event, and — critically — that the events actually
 * PERSIST to trace_events through a real TurnEmitter (not just a stub).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  RuntimeManifest,
  TurnInput,
  SubscriptionEvent,
} from "@covel/shared";
import type { LoadedRuntime, PluginRuntimeGateway } from "@covel/plugin-loader";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus, type EventBus } from "@covel/events";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import {
  createTurnEmitter,
  type TurnEmitter,
} from "../src/trace/turn-emitter.js";

function makeFunctionManifest(
  overrides?: Partial<RuntimeManifest>,
): RuntimeManifest {
  return {
    name: "fn-plugin",
    pluginId: "fn-plugin",
    pluginType: "community",
    priority: 500,
    trigger: { type: "auto" },
    model: "gpt-4o-mini",
    runtimeType: "function",
    ...overrides,
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: "sess-fn",
    turnId: "turn-fn",
    playerMessage: "hi",
    ...overrides,
  };
}

function captureEmitter(): {
  emitter: TurnEmitter;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    emitter: {
      sessionId: "sess-fn",
      turnId: "turn-fn",
      async emit(type, payload) {
        events.push({ type, payload });
      },
    },
    events,
  };
}

function makeGateway(
  overrides: Record<string, unknown> = {},
): PluginRuntimeGateway {
  return {
    generateText: async () => ({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2 },
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

const baseLLM = {
  generate: vi.fn().mockResolvedValue({
    content: "",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 0 },
  }),
};

describe("function-runtime trace (A2-P1-5)", () => {
  let store: DataStore;
  let eventBus: EventBus;

  beforeEach(() => {
    store = createMemoryStore();
    eventBus = createEventBus();
  });

  function makeDeps(
    loaded: LoadedRuntime,
    extra?: Partial<TurnExecutorDeps>,
  ): TurnExecutorDeps {
    return {
      loadRuntime: async () => loaded,
      llm: baseLLM,
      store,
      eventBus,
      ...extra,
    } as TurnExecutorDeps;
  }

  it("emits function.executing before the handler runs, then function.completed(success)", async () => {
    const { emitter, events } = captureEmitter();
    let executingSeenBeforeHandler = false;
    const loaded: LoadedRuntime = {
      manifest: makeFunctionManifest(),
      promptTemplate: "",
      handler: async () => {
        executingSeenBeforeHandler = events.some(
          (e) => e.type === "function.executing",
        );
        return { narrativeOutput: "done" };
      },
    };

    await executeTurn(
      makeTurnInput(),
      [loaded.manifest],
      makeDeps(loaded, { emitter }),
    );

    expect(executingSeenBeforeHandler).toBe(true);
    const completed = events.find((e) => e.type === "function.completed");
    expect(completed).toBeDefined();
    expect(completed!.payload.status).toBe("success");
    expect(typeof completed!.payload.durationMs).toBe("number");
  });

  it("emits function.completed(suspended) when the handler returns a suspended status", async () => {
    const { emitter, events } = captureEmitter();
    const loaded: LoadedRuntime = {
      manifest: makeFunctionManifest(),
      promptTemplate: "",
      handler: async () => ({
        status: "suspended",
        reason: "need input",
        resumeSchema: {},
      }),
    };

    await executeTurn(
      makeTurnInput(),
      [loaded.manifest],
      makeDeps(loaded, { emitter }),
    );

    const completed = events.find((e) => e.type === "function.completed");
    expect(completed?.payload.status).toBe("suspended");
  });

  it("emits function.completed(failed) and surfaces a failed result when the handler throws", async () => {
    const { emitter, events } = captureEmitter();
    const loaded: LoadedRuntime = {
      manifest: makeFunctionManifest(),
      promptTemplate: "",
      handler: async () => {
        throw new Error("kaboom");
      },
    };

    const result = await executeTurn(
      makeTurnInput(),
      [loaded.manifest],
      makeDeps(loaded, { emitter }),
    );

    const completed = events.find((e) => e.type === "function.completed");
    expect(completed?.payload.status).toBe("failed");
    expect(String(completed?.payload.error)).toContain("kaboom");
    expect(result.runtimeResults[0]!.status).toBe("failed");
  });

  it("fails the runtime when the handler exceeds manifest.timeoutMs instead of hanging the turn", async () => {
    const { emitter, events } = captureEmitter();
    const loaded: LoadedRuntime = {
      manifest: makeFunctionManifest({ timeoutMs: 50 }),
      promptTemplate: "",
      handler: async () => {
        await new Promise(() => {}); // never settles — simulates a hung provider call
        return {};
      },
    };

    const result = await executeTurn(
      makeTurnInput(),
      [loaded.manifest],
      makeDeps(loaded, { emitter }),
    );

    expect(result.runtimeResults[0]!.status).toBe("failed");
    const completed = events.find((e) => e.type === "function.completed");
    expect(completed?.payload.status).toBe("failed");
    expect(String(completed?.payload.error)).toContain("timed out after 50ms");
  });

  it("emits runtime.failed (no hanging runtime.started) when the handler is missing", async () => {
    const seen: SubscriptionEvent[] = [];
    const off = eventBus.onEmit((e) => seen.push(e));
    const loaded = {
      manifest: makeFunctionManifest(),
      promptTemplate: "",
    } as LoadedRuntime;

    const result = await executeTurn(
      makeTurnInput(),
      [loaded.manifest],
      makeDeps(loaded),
    );
    off();

    expect(result.runtimeResults[0]!.status).toBe("failed");
    expect(JSON.stringify(seen)).toContain("runtime.failed");
  });

  it("hands the handler a gateway-traced facade when an emitter is present", async () => {
    const { emitter, events } = captureEmitter();
    const rawGateway = makeGateway();
    let handlerGateway: unknown;
    const loaded: LoadedRuntime = {
      manifest: makeFunctionManifest(),
      promptTemplate: "",
      handler: async (ctx) => {
        handlerGateway = ctx.gateway;
        await ctx.gateway?.generateText({ prompt: "x" });
        return {};
      },
    };

    await executeTurn(
      makeTurnInput(),
      [loaded.manifest],
      makeDeps(loaded, { emitter, gateway: rawGateway }),
    );

    // The handler sees the wrapper, not the raw gateway, and the call traces.
    expect(handlerGateway).not.toBe(rawGateway);
    expect(events.some((e) => e.type === "gateway.calling")).toBe(true);
    expect(events.some((e) => e.type === "gateway.responded")).toBe(true);
  });

  it("passes the raw gateway through and emits no function.* when no emitter is wired", async () => {
    const rawGateway = makeGateway();
    let inHandlerResult: unknown;
    let capturedGateway: unknown;
    const loaded: LoadedRuntime = {
      manifest: makeFunctionManifest(),
      promptTemplate: "",
      handler: async (ctx) => {
        capturedGateway = ctx.gateway;
        // No emitter → no TRACE wrapping. The runtime still wraps every
        // capability in a revocation proxy, so assert pass-through from
        // INSIDE the handler (after the turn the capability is revoked).
        inHandlerResult = await ctx.gateway?.generateText({
          messages: [],
        });
        return {};
      },
    };

    await executeTurn(
      makeTurnInput(),
      [loaded.manifest],
      makeDeps(loaded, { gateway: rawGateway }),
    );

    expect(inHandlerResult).toEqual({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    // After the turn settles the captured capability is revoked — a
    // detached handler's late call must be rejected (synchronously, before
    // any store/provider work starts).
    expect(() =>
      (
        capturedGateway as { generateText: (p: unknown) => Promise<unknown> }
      ).generateText({}),
    ).toThrow(/revoked/);
  });

  // ── Persistence integration (critique HIGH gap) ──────────────────
  // Proves the headline claim: with a real TurnEmitter the new events actually
  // land in trace_events (the table /debug reads), not just a capturing stub.
  it("persists gateway.* and function.* rows to trace_events via a real TurnEmitter", async () => {
    const emitter = createTurnEmitter({
      store,
      eventBus,
      sessionId: "sess-fn",
      turnId: "turn-fn",
    });
    const rawGateway = makeGateway();
    const loaded: LoadedRuntime = {
      manifest: makeFunctionManifest(),
      promptTemplate: "",
      handler: async (ctx) => {
        await ctx.gateway!.generateText({ prompt: "hello" });
        return { narrativeOutput: "done" };
      },
    };

    await executeTurn(
      makeTurnInput(),
      [loaded.manifest],
      makeDeps(loaded, { emitter, gateway: rawGateway }),
    );

    const traces = await store.listTraceEvents("sess-fn");
    const types = traces.map((t) => t.type);
    expect(types).toContain("function.executing");
    expect(types).toContain("function.completed");
    expect(types).toContain("gateway.calling");
    expect(types).toContain("gateway.responded");
  });
});
