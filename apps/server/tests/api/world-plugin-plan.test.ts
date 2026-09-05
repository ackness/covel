import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { createMemoryStore, type DataStore } from "@covel/store";
import type { PluginRelations, WorldPluginPlan } from "@covel/shared";
import { worldPluginPlanRoutes } from "../../src/routes/api/worlds/plugin-plan.js";
import { resolveSessionPlugins } from "../../src/routes/api/session/plugins.js";

type Env = {
  Variables: { store: DataStore; pluginRegistry: PluginRegistry };
};

function entry(
  id: string,
  pluginType: "core-plugin" | "plugin",
  tags: string[] = [],
  relations?: PluginRelations,
  source: PluginRegistryEntry["source"] = "builtin",
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
      ...(relations ? { relations } : {}),
    },
    manifests: [],
    loadedRuntimes: new Map(),
    status: "registered",
    source,
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
    expect(body.defaultPluginIds.toSorted()).toEqual(["core", "dialogue"]);
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

  it("preserves legacy metadata selection without a nested plugin policy", async () => {
    await store.createWorld({
      id: "legacy-world",
      name: "Legacy world",
      description: "",
      metadata: {
        requiredPlugins: ["dialogue"],
        excludedPlugins: ["traditional", "dialogue"],
      },
      createdAt: new Date().toISOString(),
    });

    const response = await app.request("/api/worlds/legacy-world/plugin-plan");
    expect(response.status).toBe(200);
    const body = (await response.json()) as WorldPluginPlan;
    expect(body).toMatchObject({
      policy: {
        requiredPluginIds: ["dialogue"],
        excludedPluginIds: ["traditional", "dialogue"],
      },
    });
    expect(body.defaultPluginIds.toSorted()).toEqual(["core", "dialogue"]);
  });

  it("merges and deduplicates legacy and nested selection lists", async () => {
    await store.createWorld({
      id: "mixed-world",
      name: "Mixed world",
      description: "",
      metadata: {
        requiredPlugins: ["dialogue", "dialogue", "", 42],
        recommendedPlugins: ["legacy-recommended"],
        excludedPlugins: ["traditional"],
        pluginPolicy: {
          requiredPlugins: ["dialogue", "nested-required"],
          recommendedPlugins: ["legacy-recommended", "nested-recommended"],
          excludedPlugins: ["traditional", "nested-excluded"],
        },
      },
      createdAt: new Date().toISOString(),
    });

    const response = await app.request("/api/worlds/mixed-world/plugin-plan");
    expect(response.status).toBe(200);
    const body = (await response.json()) as WorldPluginPlan;
    expect(body).toMatchObject({
      policy: {
        requiredPluginIds: ["dialogue", "nested-required"],
        recommendedPluginIds: ["legacy-recommended", "nested-recommended"],
        excludedPluginIds: ["traditional", "nested-excluded"],
      },
    });
    expect(body.defaultPluginIds.toSorted()).toEqual(["core", "dialogue"]);
  });

  it.each(["builtin", "community"] as const)(
    "applies session dependency and core replacement rules to a %s provider",
    async (source) => {
      registry.register(
        entry("core", "core-plugin", [], {
          provides: ["story-provider"],
        }),
      );
      registry.register(
        entry(
          "replacement",
          "plugin",
          [],
          {
            provides: ["story-provider"],
            conflicts: ["core"],
            requires: ["dependency/helper"],
          },
          source,
        ),
      );
      registry.register(entry("dependency", "plugin"));
      await store.createWorld({
        id: "replacement-world",
        name: "Replacement world",
        description: "",
        metadata: {
          pluginPolicy: {
            requiredPlugins: ["replacement"],
            excludedPlugins: ["core"],
          },
        },
        createdAt: new Date().toISOString(),
      });

      const response = await app.request(
        "/api/worlds/replacement-world/plugin-plan",
      );
      expect(response.status).toBe(200);
      const plan = (await response.json()) as WorldPluginPlan;
      expect(plan.defaultPluginIds.toSorted()).toEqual(
        resolveSessionPlugins(["replacement"], registry).toSorted(),
      );
      if (source === "builtin") {
        expect(plan.defaultPluginIds.toSorted()).toEqual([
          "dependency",
          "replacement",
        ]);
      } else {
        expect(plan.defaultPluginIds).toContain("core");
        expect(plan.defaultPluginIds).not.toContain("replacement");
      }
    },
  );
});
