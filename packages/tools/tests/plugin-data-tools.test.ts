import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginDataTools, getPendingProposals } from "../src/index.js";
import type { ToolExecutionContext, ToolModule } from "../src/types.js";

function createMockStore() {
  return {
    setPluginData: vi.fn(),
    setPluginDataBatch: vi.fn(),
    getPluginData: vi.fn(
      async (
        _sessionId: string,
        _pluginId: string,
        namespace: string,
        key: string,
      ) => ({
        namespace,
        key,
        value: { saved: true },
        updatedAt: "2026-04-21T00:00:00.000Z",
      }),
    ),
    listPluginData: vi.fn(
      async (_sessionId: string, _pluginId: string, namespace?: string) => [
        {
          namespace: namespace ?? "entries",
          key: "alpha",
          value: { saved: true },
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
      ],
    ),
  };
}

function ctx(): ToolExecutionContext {
  return {
    sessionId: "sess-plugin-data",
    turnId: "turn-plugin-data",
    pluginId: "core-test",
    runtimeId: "core-test/runtime",
  };
}

function findByName(tools: readonly ToolModule[], name: string): ToolModule {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

describe("builtin plugin-data tools", () => {
  let store: ReturnType<typeof createMockStore>;
  let tools: readonly ToolModule[];

  beforeEach(() => {
    store = createMockStore();
    tools = createPluginDataTools(store);
  });

  it("queues a plugin.data proposal for plugin-data-set", async () => {
    const tool = findByName(tools, "plugin-data-set");
    const result = (await tool.execute(
      {
        namespace: "entries",
        key: "codex-qingping-mountain",
        value: { title: "青萍山" },
      },
      ctx(),
    )) as { success: boolean; namespace: string; key: string };

    expect(result).toEqual({
      success: true,
      namespace: "entries",
      key: "codex-qingping-mountain",
    });
    expect(store.setPluginData).not.toHaveBeenCalled();

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      sessionId: "sess-plugin-data",
      turnId: "turn-plugin-data",
      source: { pluginId: "core-test", runtimeId: "core-test/runtime" },
      payload: {
        namespace: "entries",
        key: "codex-qingping-mountain",
        value: { title: "青萍山" },
      },
    });
  });

  it("queues one batch proposal for plugin-data-set-batch", async () => {
    const tool = findByName(tools, "plugin-data-set-batch");
    const result = (await tool.execute(
      {
        items: [
          {
            namespace: "entries",
            key: "geography",
            value: { region: "云梦泽" },
          },
          { namespace: "entries", key: "factions", value: { name: "青萍宗" } },
        ],
      },
      ctx(),
    )) as { success: boolean; count: number };

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(store.setPluginDataBatch).not.toHaveBeenCalled();

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data.batch",
      payload: {
        items: [
          {
            namespace: "entries",
            key: "geography",
            value: { region: "云梦泽" },
          },
          { namespace: "entries", key: "factions", value: { name: "青萍宗" } },
        ],
      },
    });
  });

  it("reads single records through plugin-data-get", async () => {
    const tool = findByName(tools, "plugin-data-get");
    const result = (await tool.execute(
      {
        namespace: "entries",
        key: "alpha",
      },
      ctx(),
    )) as { found: boolean; namespace: string; key: string; value: unknown };

    expect(result.found).toBe(true);
    expect(result.namespace).toBe("entries");
    expect(result.key).toBe("alpha");
    expect(result.value).toEqual({ saved: true });
    expect(store.getPluginData).toHaveBeenCalledOnce();
  });

  it("lists records through plugin-data-list", async () => {
    const tool = findByName(tools, "plugin-data-list");
    const result = (await tool.execute(
      {
        namespace: "entries",
      },
      ctx(),
    )) as { count: number; items: Array<{ key: string }> };

    expect(result.count).toBe(1);
    expect(result.items[0]?.key).toBe("alpha");
    expect(store.listPluginData).toHaveBeenCalledOnce();
  });
});
