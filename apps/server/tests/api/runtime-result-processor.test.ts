import { describe, expect, it, vi } from "vitest";
import type { RuntimeResult } from "@covel/shared";
import { createHookPipeline, type KernelStore } from "@covel/runtime";
import { createRuntimeResultProcessor } from "../../src/routes/api/runtime-result-processor.js";

function makeRuntimeResult(
  runtimeId: string,
  output: Record<string, unknown>,
): RuntimeResult {
  return {
    pluginId: runtimeId,
    runtimeId,
    runId: `${runtimeId}-run`,
    turnId: "turn-1",
    status: "success",
    output,
    toolCalls: [],
    durationMs: 1,
    timestamp: "2026-05-09T00:00:00.000Z",
  };
}

describe("createRuntimeResultProcessor", () => {
  it("uses runtime manifests for output kind and capability lookup", () => {
    const processor = createRuntimeResultProcessor({
      store: {} as KernelStore,
      sessionId: "session-1",
      runtimes: [
        {
          name: "story-runtime",
          outputKind: "story",
          capabilities: ["asset.generate"],
        },
      ],
    });

    expect(processor.getOutputKind("story-runtime")).toBe("story");
    expect(processor.getCapabilities("story-runtime")).toEqual([
      "asset.generate",
    ]);
    expect(processor.getOutputKind("unknown-runtime")).toBe("plugin");
    expect(processor.getCapabilities("unknown-runtime")).toEqual([]);
  });

  it("processes runtime results sequentially through the shared commit path", async () => {
    const order: string[] = [];
    const store = {
      async addMessage(record: { content: string }) {
        order.push(record.content);
      },
      async saveEvent() {},
      async updateSession() {},
      async addStateChange() {},
      async addTraceEvent() {},
    } as unknown as KernelStore;

    const processor = createRuntimeResultProcessor({
      store,
      sessionId: "session-1",
      runtimes: [
        { name: "first", outputKind: "story", capabilities: [] },
        { name: "second", outputKind: "story", capabilities: [] },
      ],
    });

    const outputs = await processor.processAll([
      makeRuntimeResult("first", { narrativeOutput: "first message" }),
      makeRuntimeResult("second", { narrativeOutput: "second message" }),
    ]);

    expect(outputs).toHaveLength(2);
    expect(order).toEqual(["first message", "second message"]);
  });

  it("passes hook pipeline and emitter through to successful commits", async () => {
    const hookPipeline = createHookPipeline();
    const preHook = vi.fn().mockResolvedValue({ action: "continue" });
    const postHook = vi.fn().mockResolvedValue({ action: "continue" });
    hookPipeline.register({
      id: "test:PreStateCommit",
      event: "PreStateCommit",
      handler: preHook,
    });
    hookPipeline.register({
      id: "test:PostStateCommit",
      event: "PostStateCommit",
      handler: postHook,
    });
    const emitter = {
      sessionId: "session-1",
      turnId: "turn-1",
      emit: vi.fn(async () => undefined),
    };
    const store = {
      async addMessage() {},
      async saveEvent() {},
      async updateSession() {},
      async addStateChange() {},
      async addTraceEvent() {},
      async setPluginData() {},
    } as unknown as KernelStore;

    const processor = createRuntimeResultProcessor({
      store,
      sessionId: "session-1",
      runtimes: [
        {
          name: "asset-runtime",
          outputKind: "plugin",
          capabilities: ["asset.generate"],
        },
      ],
      hookPipeline,
      emitter,
    });

    await processor.process(
      makeRuntimeResult("asset-runtime", {
        pluginData: [{ namespace: "gallery", key: "last", value: "asset-1" }],
      }),
    );

    expect(preHook).toHaveBeenCalledOnce();
    expect(postHook).toHaveBeenCalledOnce();
    expect(emitter.emit).toHaveBeenCalled();
  });

  it("passes event bus through to hook abort observability", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "test:PreStateCommit:abort",
      event: "PreStateCommit",
      handler: vi
        .fn()
        .mockResolvedValue({ action: "abort", reason: "blocked" }),
    });
    const eventBus = { emit: vi.fn() };
    const store = {
      async addMessage() {},
      async saveEvent() {},
      async updateSession() {},
      async addStateChange() {},
      async addTraceEvent() {},
    } as unknown as KernelStore;

    const processor = createRuntimeResultProcessor({
      store,
      sessionId: "session-1",
      runtimes: [{ name: "story-runtime", outputKind: "story" }],
      hookPipeline,
      eventBus,
    });

    const output = await processor.process(
      makeRuntimeResult("story-runtime", { narrativeOutput: "blocked" }),
    );

    expect(output.failedProposals).toHaveLength(1);
    expect(eventBus.emit).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
