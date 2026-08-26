import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import type { RuntimeResult } from "@covel/shared";
import {
  createHookPipeline,
  createTurnEmitter,
  type KernelStore,
} from "@covel/runtime";
import { createRuntimeResultProcessor } from "../../src/routes/api/runtime-result-processor.js";

function makeRuntimeResult(
  runtimeId: string,
  output: Record<string, unknown>,
  overrides: Partial<RuntimeResult> = {},
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
    ...overrides,
  };
}

function createRecordingStore() {
  const messages: Array<Record<string, unknown>> = [];
  const traceEvents: Array<Record<string, unknown>> = [];
  const store = {
    async addMessage(record: Record<string, unknown>) {
      messages.push(record);
    },
    async saveEvent() {},
    async updateSession() {},
    async addStateChange() {},
    async addTraceEvent(record: Record<string, unknown>) {
      traceEvents.push(record);
    },
  } as unknown as KernelStore;

  return { store, messages, traceEvents };
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

  it("scopes hooks and forwards the committed asset session, turn, and trace event", async () => {
    const hookPipeline = createHookPipeline();
    const preHook = vi.fn().mockResolvedValue({ action: "continue" });
    const postHook = vi.fn().mockResolvedValue({ action: "continue" });
    hookPipeline.register({
      id: "asset-plugin:PreStateCommit",
      event: "PreStateCommit",
      pluginId: "asset-plugin",
      handler: preHook,
    });
    hookPipeline.register({
      id: "asset-plugin:PostStateCommit",
      event: "PostStateCommit",
      pluginId: "asset-plugin",
      handler: postHook,
    });
    const inactiveHook = vi.fn().mockResolvedValue({ action: "continue" });
    hookPipeline.register({
      id: "inactive-plugin:PreStateCommit",
      event: "PreStateCommit",
      pluginId: "inactive-plugin",
      handler: inactiveHook,
    });

    const { store, messages, traceEvents } = createRecordingStore();
    const eventBus = createEventBus();
    const busEvents: Array<{
      type: string;
      sessionId: string;
      payload: Record<string, unknown>;
    }> = [];
    eventBus.onEmit((event) => {
      busEvents.push({
        type: event.type,
        sessionId: event.sessionId,
        payload: event.payload as Record<string, unknown>,
      });
    });
    const emitter = createTurnEmitter({
      store,
      eventBus,
      sessionId: "session-1",
      turnId: "turn-1",
      traceId: "asset-trace-1",
    });

    const processor = createRuntimeResultProcessor({
      store,
      sessionId: "session-1",
      runtimes: [
        {
          name: "asset-runtime",
          pluginId: "asset-plugin",
          outputKind: "plugin",
          capabilities: ["image-generation"],
        },
        { name: "other-runtime", pluginId: "other-plugin" },
      ],
      hookPipeline,
      eventBus,
      emitter,
    });

    const output = await processor.process(
      makeRuntimeResult(
        "asset-runtime",
        {
          assetGenerations: [
            {
              ref: {
                id: "a".repeat(64),
                mime: "image/png",
                size: 42,
              },
              modality: "image",
              meta: { prompt: "forest" },
            },
          ],
        },
        { pluginId: "asset-plugin" },
      ),
    );

    expect(output.failedProposals).toEqual([]);
    expect(messages).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        metadata: expect.objectContaining({
          turnId: "turn-1",
          runtimeId: "asset-runtime",
          block: expect.objectContaining({ type: "asset.generate" }),
        }),
      }),
    ]);
    expect(preHook).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        pluginId: "asset-plugin",
        runtimeId: "asset-runtime",
        activePluginIds: new Set(["asset-plugin", "other-plugin"]),
      }),
      expect.objectContaining({
        proposal: expect.objectContaining({
          type: "asset.generate",
          sessionId: "session-1",
          turnId: "turn-1",
          source: { pluginId: "asset-plugin", runtimeId: "asset-runtime" },
        }),
      }),
    );
    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", turnId: "turn-1" }),
      expect.objectContaining({
        proposal: expect.objectContaining({ type: "asset.generate" }),
        result: { committed: true, event: expect.any(Object) },
      }),
    );
    expect(inactiveHook).not.toHaveBeenCalled();

    expect(traceEvents).toContainEqual(
      expect.objectContaining({
        type: "asset.generated",
        sessionId: "session-1",
        turnId: "turn-1",
        traceId: "asset-trace-1",
      }),
    );
    expect(busEvents.find((event) => event.type === "asset.generated")).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        payload: expect.objectContaining({
          turnId: "turn-1",
          runtimeId: "asset-runtime",
          pluginId: "asset-plugin",
          flowId: "asset-trace-1",
        }),
      }),
    );
  });

  it("reports an active hook abort and prevents the rejected domain write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "story-plugin:PreStateCommit:abort",
      event: "PreStateCommit",
      pluginId: "story-plugin",
      handler: vi
        .fn()
        .mockResolvedValue({ action: "abort", reason: "blocked" }),
    });
    const { store, messages } = createRecordingStore();
    const eventBus = createEventBus();
    const busEvents: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    eventBus.onEmit((event) => {
      busEvents.push({
        type: event.type,
        payload: event.payload as Record<string, unknown>,
      });
    });

    const processor = createRuntimeResultProcessor({
      store,
      sessionId: "session-1",
      runtimes: [
        {
          name: "story-runtime",
          pluginId: "story-plugin",
          outputKind: "story",
          capabilities: [],
        },
      ],
      hookPipeline,
      eventBus,
    });

    const output = await processor.process(
      makeRuntimeResult(
        "story-runtime",
        { narrativeOutput: "blocked" },
        { pluginId: "story-plugin" },
      ),
    );

    expect(output.failedProposals).toEqual([
      expect.objectContaining({
        error: "pre-state-commit hook aborted: blocked",
        proposal: expect.objectContaining({
          type: "narrative.append",
          sessionId: "session-1",
          turnId: "turn-1",
        }),
      }),
    ]);
    expect(messages).toEqual([]);
    expect(busEvents).toEqual([
      expect.objectContaining({
        type: "hook.aborted",
        payload: {
          event: "PreStateCommit",
          sessionId: "session-1",
          turnId: "turn-1",
          pluginId: "story-plugin",
          runtimeId: "story-runtime",
          hookId: "story-plugin:PreStateCommit:abort",
          hookPluginId: "story-plugin",
          reason: "blocked",
        },
      }),
    ]);
    warn.mockRestore();
  });
});
