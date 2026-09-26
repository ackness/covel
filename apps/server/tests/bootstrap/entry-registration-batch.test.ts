import { describe, expect, it, vi } from "vitest";
import {
  getImageWire,
  getSpeechWire,
  getTranscriptionWire,
} from "@covel/ai-provider";
import { createHookPipeline, createPluginRpcRegistry } from "@covel/runtime";
import { createMemoryStore } from "@covel/store";
import { ToolRegistry, type ToolModule } from "@covel/tools";
import { EntryRegistrationBatch } from "../../src/routes/api/bootstrap/entry-registration-batch.js";
import { buildEntryApi } from "../../src/routes/api/bootstrap/plugin-entry-api.js";
import type { BootstrapPluginEntriesParams } from "../../src/routes/api/bootstrap/plugin-entry.js";

function fixture() {
  const batch = new EntryRegistrationBatch();
  const params: BootstrapPluginEntriesParams = {
    discoveryMap: new Map(),
    manifestCache: new Map(),
    store: createMemoryStore(),
    tools: new ToolRegistry(),
    hookPipeline: createHookPipeline(),
    rpcRegistry: createPluginRpcRegistry(),
    isCommunityHookApproved: () => true,
  };
  const api = buildEntryApi(params, "batch-fixture", batch);
  return { batch, params, api };
}

const ctx = { event: "TurnStart" as const, sessionId: "s1", turnId: "t1" };

describe("entry publication", () => {
  it("publishes all capabilities only after successful initialization", async () => {
    const { batch, params, api } = fixture();
    const hook = vi.fn(async () => ({ action: "continue" as const }));
    api.registerTool(
      api.toolkit.tool({
        name: "staged",
        description: "fixture",
        parameters: api.toolkit.z.object({}),
        execute: async () => ({}),
      }),
    );
    api.on("TurnStart", hook);
    api.registerRpc("staged", async () => true);
    api.registerFormValidator("staged", () => undefined);
    expect(
      params.rpcRegistry.getFormValidator("batch-fixture", "staged"),
    ).toBeUndefined();
    expect(params.tools.pluginTools.size).toBe(0);
    expect(params.rpcRegistry.list()).toEqual([]);
    await params.hookPipeline.run("TurnStart", ctx, {});
    expect(hook).not.toHaveBeenCalled();
    batch.commit();
    expect(
      params.rpcRegistry.getFormValidator("batch-fixture", "staged"),
    ).toBeDefined();
    expect(params.tools.pluginTools.get("batch-fixture")?.has("staged")).toBe(
      true,
    );
    expect(
      params.rpcRegistry.getPluginAction("batch-fixture", "staged"),
    ).toBeDefined();
    await params.hookPipeline.run("TurnStart", ctx, {});
    expect(hook).toHaveBeenCalledOnce();
    expect(() => api.registerRpc("late", async () => true)).toThrow(
      "registration is closed",
    );
    batch.dispose();
    expect(params.tools.pluginTools.size).toBe(0);
    expect(params.rpcRegistry.list()).toEqual([]);
    expect(
      params.rpcRegistry.getFormValidator("batch-fixture", "staged"),
    ).toBeUndefined();
    await params.hookPipeline.run("TurnStart", ctx, {});
    expect(hook).toHaveBeenCalledOnce();
    expect(() => batch.dispose()).not.toThrow();
  });

  it("rolls back a failed publication across tools, hooks, RPC, and every wire kind", async () => {
    const { batch, params, api } = fixture();
    const existing = { name: "existing", _type: "covel-tool" } as ToolModule;
    params.tools.pluginTools.set("other", new Map([["existing", existing]]));
    const hook = vi.fn(async () => ({ action: "continue" as const }));
    api.registerTool(
      api.toolkit.tool({
        name: "rollback-tool",
        description: "fixture",
        parameters: api.toolkit.z.object({}),
        execute: async () => ({}),
      }),
    );
    api.on("TurnStart", hook);
    api.registerRpc("rollback-rpc", async () => true);
    api.registerFormValidator("rollback-form", () => undefined);
    api.registerWires({
      image: [{ id: "rollback", generate: vi.fn() }],
      speech: [{ id: "rollback", synthesize: vi.fn() }],
      transcription: [{ id: "rollback", transcribe: vi.fn() }],
    });
    batch.stage(() => {
      throw new Error("publication failed");
    });
    expect(() => batch.commit()).toThrow("publication failed");
    batch.rollback();
    batch.rollback();
    expect([...params.tools.pluginTools.get("other")!.values()]).toEqual([
      existing,
    ]);
    expect(params.rpcRegistry.list()).toEqual([]);
    expect(
      params.rpcRegistry.getFormValidator("batch-fixture", "rollback-form"),
    ).toBeUndefined();
    await params.hookPipeline.run("TurnStart", ctx, {});
    expect(hook).not.toHaveBeenCalled();
    expect(getImageWire("batch-fixture/rollback")).toBeNull();
    expect(getSpeechWire("batch-fixture/rollback")).toBeNull();
    expect(getTranscriptionWire("batch-fixture/rollback")).toBeNull();
  });

  it("continues reverse-order cleanup after a disposer fails and closes failed APIs", () => {
    const { batch, api } = fixture();
    const order: number[] = [];
    batch.track(() => order.push(1));
    batch.track(() => {
      order.push(2);
      throw new Error("cleanup failed");
    });
    batch.track(() => order.push(3));
    expect(() => batch.rollback()).toThrow(AggregateError);
    expect(order).toEqual([3, 2, 1]);
    expect(() => batch.rollback()).not.toThrow();
    expect(() => api.registerRpc("late", async () => true)).toThrow(
      "registration is closed",
    );
  });
});
