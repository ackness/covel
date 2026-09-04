import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { createMemoryStore, type DataStore } from "@covel/store";
import { worldPluginPlanRoutes } from "../../src/routes/api/worlds/plugin-plan.js";

type Env = {
  Variables: { store: DataStore; pluginRegistry: PluginRegistry };
};

function entry(
  id: string,
  pluginType: "core-plugin" | "plugin",
  tags: string[] = [],
): PluginRegistryEntry {
  return {
    id,
    summary: {
      id,
      name: id,
      description: `${id} plugin`,
      pluginType,
      runtimeCount: 0,
      tags,
    },
    manifests: [],
    loadedRuntimes: new Map(),
    status: "registered",
    source: "builtin",
  };
}

describe("GET /api/worlds/:id/plugin-plan", () => {
  let store: DataStore;
  let registry: PluginRegistry;
  let app: Hono<Env>;

  beforeEach(async () => {
    store = createMemoryStore();
    registry = createPluginRegistry();
    registry.register(entry("core", "core-plugin"));
    registry.register(entry("dialogue", "plugin", ["mode:dialogue"]));
    registry.register(entry("traditional", "plugin", ["mode:traditional"]));
    app = new Hono<Env>();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      await next();
    });
    app.route("/api/worlds", worldPluginPlanRoutes);
  });

  it("resolves world policy, custom packs, and defaults on the server", async () => {
    await store.upsertWorld({
      id: "dialogue-world",
      name: "Dialogue world",
      description: "",
      metadata: {
        pluginPolicy: {
          preset: "custom-dialogue",
          preferTags: ["mode:dialogue"],
          avoidTags: ["mode:traditional"],
          packs: [
            {
              id: "custom-dialogue",
              label: { "zh-CN": "自定义对话", invalid: 42 },
              plugins: ["dialogue"],
              excludedPlugins: ["traditional", "core"],
            },
          ],
        },
      },
      createdAt: new Date().toISOString(),
    });

    const response = await app.request(
      "/api/worlds/dialogue-world/plugin-plan",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      selectedPackId: string;
      defaultPluginIds: string[];
      packs: Array<{ id: string; label: Record<string, string> }>;
    };
    expect(body.selectedPackId).toBe("custom-dialogue");
    expect(body.defaultPluginIds).toEqual(["core", "dialogue"]);
    expect(body.packs[0]?.label).toEqual({ "zh-CN": "自定义对话" });
    expect(
      body.packs.find((pack) => pack.id === "dialogue-mode")?.label["ru-RU"],
    ).toBe("Диалоговый режим");
  });

  it("returns a coded 404 for an unknown world", async () => {
    const response = await app.request("/api/worlds/missing/plugin-plan");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "world_not_found",
    });
  });
});
