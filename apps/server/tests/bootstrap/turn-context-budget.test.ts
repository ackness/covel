import registerCompaction from "../../../../plugins/history-compaction/server/index.js";
import { describe, it, expect, vi } from "vitest";
import {
  PluginExtensionHost,
  PluginServiceRegistry,
  createTurnEmitter,
  type LLMAdapter,
  type LLMResponse,
} from "@covel/runtime";
import { type TurnMessageRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  createBootstrapCompactorRunner,
  createTurnContextBudget,
} from "../../src/routes/api/bootstrap/compactor.js";

describe("createTurnContextBudget", () => {
  it("retains the explicit deployment ceiling", () => {
    const budget = createTurnContextBudget({ contextWindowOverride: 8000 });
    expect(budget.maxInputTokens).toBe(8000);
    expect(budget.reservedForResponse).toBe(4000);
    expect(budget.contextWindowLimit).toBe(8000);
  });

  it("falls back to 262144 / 16384 without imposing a model ceiling", () => {
    const budget = createTurnContextBudget({});
    expect(budget.maxInputTokens).toBe(262_144);
    expect(budget.reservedForResponse).toBe(16_384);
    expect(budget.contextWindowLimit).toBeUndefined();
  });

  it("rejects an invalid deployment window", () => {
    expect(() => createTurnContextBudget({ contextWindowOverride: 0 })).toThrow(
      RangeError,
    );
  });
});

describe("createBootstrapCompactorRunner", () => {
  it("triggers against input capacity after reserving the configured response budget", async () => {
    const store = createMemoryStore();
    const generate = vi.fn(async (): Promise<LLMResponse> => ({
      content: "bounded summary",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const resolveBudget = vi.fn(() => ({
      contextWindow: 1000,
      maxOutputTokens: 400,
    }));
    const llmAdapter: LLMAdapter = { generate, resolveBudget };
    const messages: TurnMessageRecord[] = Array.from(
      { length: 10 },
      (_, index) => ({
        id: `message-${index}`,
        sessionId: "session-1",
        turnId: `turn-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        sourceType: index % 2 === 0 ? "player" : "narrative",
        order: index,
        content: "x".repeat(200),
        createdAt: new Date(index).toISOString(),
      }),
    );
    for (const message of messages) await store.appendTurnMessage(message);

    const services = new PluginServiceRegistry({
      list: async () => ["history-compaction"],
      ensure: async () => {},
    });
    const extensions = new PluginExtensionHost(services);
    registerCompaction({
      provideExtension(point, id, implementation) {
        extensions.register(
          "history-compaction",
          { point, id },
          implementation,
        );
      },
    });
    const runner = createBootstrapCompactorRunner({
      extensions,
      store,
      llmAdapter,
    });

    const emitter = createTurnEmitter({
      store,
      sessionId: "session-1",
      turnId: "current-turn",
      traceId: "current-flow",
    });
    await emitter.emit("hook.fired", {});
    const result = await runner.run(
      "session-1",
      "",
      messages,
      "en-US",
      emitter.traceId,
      emitter,
    );
    await emitter.emit("hook.fired", {});

    expect(result.compacted).toBe(true);
    expect(resolveBudget).toHaveBeenCalledWith("fast");
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "fast", maxOutputTokens: 400 }),
    );
    const traces = await store.listTraceEvents("session-1");
    expect(
      traces.find((trace) => trace.type === "plugin.service.completed"),
    ).toMatchObject({
      turnId: "current-turn",
      traceId: "current-flow",
      payload: {
        outcome: "success",
        extension: { point: "history.compact@2" },
        seq: 1,
      },
    });
    expect(
      traces
        .filter(
          (trace) =>
            trace.type === "hook.fired" ||
            trace.type === "plugin.service.completed",
        )
        .map((trace) => (trace.payload as { seq: number }).seq),
    ).toEqual([0, 1, 2]);
    await store.close();
  });

  it.each([
    { story: 1_000, fast: 10_000 },
    { story: 10_000, fast: 1_000 },
  ])(
    "uses the smaller story/fast capacity for admission and fast capacity for summary input: %j",
    async ({ story, fast }) => {
      const store = createMemoryStore();
      const services = new PluginServiceRegistry({
        list: async () => ["summary-provider"],
        ensure: async () => {},
      });
      const extensions = new PluginExtensionHost(services);
      const handler = vi.fn(async () => null);
      extensions.register(
        "summary-provider",
        { point: "history.compact@2", id: "summary" },
        { handler },
      );
      const generate = vi.fn(async (): Promise<LLMResponse> => ({
        content: "summary",
        toolCalls: [],
        finishReason: "stop",
      }));
      const llmAdapter: LLMAdapter = {
        generate,
        resolveBudget: (slot) => ({
          contextWindow: slot === "story" ? story : fast,
          maxOutputTokens: 200,
        }),
      };
      const runner = createBootstrapCompactorRunner({
        extensions,
        store,
        llmAdapter,
      });
      const message: TurnMessageRecord = {
        id: "history",
        sessionId: "session-1",
        turnId: "turn-1",
        role: "user",
        sourceType: "player",
        order: 0,
        content: "x".repeat(2_000),
        createdAt: new Date(0).toISOString(),
      };
      await runner.run("session-1", "", [message], "en-US");
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          contextWindow: 800,
          inputWindow: fast - 200,
          summaryBudget: expect.objectContaining({ maxTokens: 128 }),
        }),
        expect.anything(),
      );
      expect(generate).not.toHaveBeenCalled();
    },
  );
});
