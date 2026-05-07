import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorldDimensionTools } from "../src/builtin/world-dimension-tools.js";
import type { ToolExecutionContext, ToolModule } from "../src/types.js";

interface SessionLike {
  id: string;
  worldId?: string;
  locale?: string;
}

interface WorldLike {
  id: string;
  metadata?: unknown;
}

interface PluginDataLike {
  sessionId: string;
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

function createMockStore() {
  const sessions = new Map<string, SessionLike>();
  const worlds = new Map<string, WorldLike>();
  const pluginData = new Map<string, PluginDataLike>();

  return {
    sessions,
    worlds,
    pluginData,
    getSession: vi.fn(
      async (sessionId: string) => sessions.get(sessionId) ?? null,
    ),
    getWorld: vi.fn(async (worldId: string) => worlds.get(worldId) ?? null),
    getPluginData: vi.fn(
      async (
        sessionId: string,
        pluginId: string,
        namespace: string,
        key: string,
      ) =>
        pluginData.get(`${sessionId}:${pluginId}:${namespace}:${key}`) ?? null,
    ),
  };
}

function seedPluginData(
  store: ReturnType<typeof createMockStore>,
  record: PluginDataLike,
): void {
  store.pluginData.set(
    `${record.sessionId}:${record.pluginId}:${record.namespace}:${record.key}`,
    record,
  );
}

function ctx(
  sessionId = "sess-1",
  pluginId = "narrator",
): ToolExecutionContext {
  return {
    sessionId,
    turnId: "turn-1",
    pluginId,
    runtimeId: `${pluginId}/runtime`,
  };
}

function findByName(tools: readonly ToolModule[], name: string): ToolModule {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

describe("builtin world dimension tools", () => {
  let store: ReturnType<typeof createMockStore>;
  let tools: readonly ToolModule[];
  let findWorldDataPluginId: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createMockStore();
    findWorldDataPluginId = vi.fn(() => "world-init");
    tools = createWorldDimensionTools(store, { findWorldDataPluginId });

    store.sessions.set("sess-1", {
      id: "sess-1",
      worldId: "world-1",
      locale: "zh-CN",
    });
    store.worlds.set("world-1", {
      id: "world-1",
      metadata: {
        dimensions: {
          tone: {
            contentRating: "teen",
            narrativeStyle: {
              "zh-CN": "古风叙事",
              "en-US": "Classical fantasy prose",
            },
          },
          geography: {
            regions: [
              {
                name: {
                  "zh-CN": "青萍山",
                  "en-US": "Qingping Mountain",
                },
              },
            ],
          },
        },
      },
    });
  });

  it("factory returns the world-dimension-get tool", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["world-dimension-get"]);
  });

  it("prefers plugin_data entries over world metadata", async () => {
    seedPluginData(store, {
      sessionId: "sess-1",
      pluginId: "world-init",
      namespace: "entries",
      key: "tone",
      value: {
        contentRating: "mature",
        narrativeStyle: { "zh-CN": "硬派黑色叙事", "en-US": "Hardboiled noir" },
      },
      updatedAt: "2026-04-13T00:00:00.000Z",
    });

    const tool = findByName(tools, "world-dimension-get");
    const result = (await tool.execute(
      {
        queries: [{ dimension: "tone", path: "contentRating" }],
      },
      ctx(),
    )) as {
      _text: string;
      results: Array<{ source: string; value: unknown; found: boolean }>;
    };

    expect(result.results).toEqual([
      expect.objectContaining({
        found: true,
        source: "plugin-data",
        value: "mature",
      }),
    ]);
    expect(result._text).toContain("[plugin-data]");
    expect(store.getPluginData).toHaveBeenCalledTimes(1);
  });

  it("falls back to world metadata when plugin_data entry is missing", async () => {
    const tool = findByName(tools, "world-dimension-get");
    const result = (await tool.execute(
      {
        queries: [{ dimension: "tone", path: "contentRating" }],
      },
      ctx(),
    )) as {
      results: Array<{ source: string; value: unknown; found: boolean }>;
    };

    expect(result.results).toEqual([
      expect.objectContaining({
        found: true,
        source: "world-metadata",
        value: "teen",
      }),
    ]);
    expect(store.getWorld).toHaveBeenCalledTimes(1);
  });

  it("supports nested array/object paths and resolves i18n by session locale", async () => {
    const tool = findByName(tools, "world-dimension-get");
    const result = (await tool.execute(
      {
        queries: [{ dimension: "geography", path: "regions[0].name" }],
      },
      ctx(),
    )) as {
      results: Array<{ value: unknown; found: boolean }>;
    };

    expect(result.results).toEqual([
      expect.objectContaining({
        found: true,
        value: "青萍山",
      }),
    ]);
  });

  it("returns the raw i18n object when resolveI18n=false", async () => {
    const tool = findByName(tools, "world-dimension-get");
    const result = (await tool.execute(
      {
        queries: [{ dimension: "tone", path: "narrativeStyle" }],
        resolveI18n: false,
      },
      ctx(),
    )) as {
      results: Array<{ value: unknown; found: boolean }>;
    };

    expect(result.results[0]).toEqual(
      expect.objectContaining({
        found: true,
        value: {
          "zh-CN": "古风叙事",
          "en-US": "Classical fantasy prose",
        },
      }),
    );
  });

  it("returns localized full-dimension objects when path is omitted", async () => {
    const tool = findByName(tools, "world-dimension-get");
    const result = (await tool.execute(
      {
        queries: [{ dimension: "geography" }],
      },
      ctx(),
    )) as {
      results: Array<{ value: unknown; found: boolean }>;
    };

    expect(result.results[0]).toEqual(
      expect.objectContaining({
        found: true,
        value: {
          regions: [{ name: "青萍山" }],
        },
      }),
    );
  });

  it("reports missing field paths without throwing", async () => {
    const tool = findByName(tools, "world-dimension-get");
    const result = (await tool.execute(
      {
        queries: [{ dimension: "tone", path: "themes[0]" }],
      },
      ctx(),
    )) as {
      _text: string;
      results: Array<{
        found: boolean;
        error: string | null;
        source: string | null;
      }>;
    };

    expect(result.results[0]).toEqual(
      expect.objectContaining({
        found: false,
        source: "world-metadata",
        error: "Field path not found",
      }),
    );
    expect(result._text).toContain("not found");
  });

  it("reports invalid path syntax as a query error", async () => {
    const tool = findByName(tools, "world-dimension-get");
    const result = (await tool.execute(
      {
        queries: [{ dimension: "tone", path: "genres[abc]" }],
      },
      ctx(),
    )) as {
      results: Array<{ found: boolean; error: string | null }>;
    };

    expect(result.results[0]).toEqual(
      expect.objectContaining({
        found: false,
        error: "Invalid path syntax: genres[abc]",
      }),
    );
  });

  it("still works when no world-data-provider plugin is active", async () => {
    findWorldDataPluginId.mockReturnValue(undefined);
    const tool = findByName(tools, "world-dimension-get");
    const result = (await tool.execute(
      {
        queries: [{ dimension: "tone", path: "contentRating" }],
      },
      ctx(),
    )) as {
      results: Array<{ found: boolean; source: string | null; value: unknown }>;
    };

    expect(result.results[0]).toEqual(
      expect.objectContaining({
        found: true,
        source: "world-metadata",
        value: "teen",
      }),
    );
  });
});
