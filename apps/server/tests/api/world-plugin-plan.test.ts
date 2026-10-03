import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createPluginRegistry,
  parsePluginMd,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  resolveSessionPlugins,
  type PluginManifest,
  type WorldPluginPlan,
} from "@covel/shared";
import { buildPluginSummary } from "../../src/lib/plugin-descriptor.js";
import { worldPluginPlanRoutes } from "../../src/routes/api/worlds/plugin-plan.js";
import {
  resolveSessionPluginPlan,
  unknownPluginIds,
} from "../../src/routes/api/session/plugins.js";

type Env = { Variables: { store: DataStore; pluginRegistry: PluginRegistry } };
function entry(
  id: string,
  fields: Partial<PluginManifest> = {},
  source: PluginRegistryEntry["source"] = "builtin",
): PluginRegistryEntry {
  const plugin = { id, kind: "plugin", description: id, ...fields };
  const root = parsePluginMd(
    `---\n${JSON.stringify(plugin)}\n---\n`,
    `${id}/PLUGIN.md`,
  );
  return {
    id,
    summary: {
      id,
      name: id,
      description: id,
      pluginType: fields.kind === "core" ? "core-plugin" : "plugin",
      runtimeCount: 0,
      tags: fields.tags ?? [],
    },
    packageManifest: root,
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
  beforeEach(() => {
    store = createMemoryStore();
    registry = createPluginRegistry();
    registry.register(entry("core", { kind: "core" }));
    registry.register(entry("dialogue", { tags: ["mode:dialogue"] }));
    registry.register(entry("traditional", { tags: ["mode:traditional"] }));
    app = new Hono<Env>();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      await next();
    });
    app.route("/api/worlds", worldPluginPlanRoutes);
  });
  async function plan(
    policy: Record<string, unknown>,
  ): Promise<WorldPluginPlan> {
    await store.createWorld({
      id: "world",
      name: "World",
      description: "",
      metadata: { pluginPolicy: policy },
      createdAt: new Date().toISOString(),
    });
    const response = await app.request("/api/worlds/world/plugin-plan");
    expect(response.status).toBe(200);
    return response.json();
  }
  it("returns explicit requests from the preset and preferred tags without promoting core defaults", async () => {
    const result = await plan({
      presetId: "custom",
      preferredTags: ["mode:dialogue"],
      avoidedTags: ["mode:traditional"],
      packs: [
        {
          id: "custom",
          label: { "zh-CN": "自定义", invalid: 42 },
          requested: ["dialogue"],
          recommended: ["traditional"],
        },
      ],
    });
    expect(result.selectedPackId).toBe("custom");
    expect(result.defaultPluginIds).toEqual(["dialogue"]);
    expect(result.packs[0]).toMatchObject({
      label: { "zh-CN": "自定义" },
      requested: ["dialogue"],
      recommended: ["traditional"],
    });
    expect(
      resolveSessionPluginPlan(result.defaultPluginIds, registry).active,
    ).toEqual(["dialogue", "core"]);
  });
  it("keeps recommendations inactive until explicitly requested", async () => {
    const result = await plan({
      recommended: ["dialogue"],
      presetId: "recommendations",
      packs: [
        { id: "recommendations", requested: [], recommended: ["traditional"] },
      ],
    });
    expect(result.defaultPluginIds).toEqual([]);
    expect(result.policy.recommended).toEqual(["dialogue"]);
  });
  it("preserves explicit requests despite avoided tag preferences", async () => {
    const result = await plan({
      requested: ["traditional"],
      preferredTags: ["mode:dialogue"],
      avoidedTags: ["mode:traditional"],
    });
    expect(result.defaultPluginIds).toEqual(["traditional", "dialogue"]);
  });
  it("reports requested plugins the registry lacks instead of passing them on", async () => {
    const result = await plan({
      presetId: "custom",
      requested: ["dialogue", "absent-from-policy"],
      packs: [
        {
          id: "custom",
          label: "Custom",
          requested: ["traditional", "absent-from-pack"],
          recommended: ["absent-recommended"],
        },
      ],
    });
    expect(result.policy.requested).toEqual(["dialogue"]);
    expect(result.packs[0]).toMatchObject({
      requested: ["traditional"],
      recommended: ["absent-recommended"],
    });
    expect(result.defaultPluginIds).toEqual(["dialogue", "traditional"]);
    // Builtin packs name plugins this test registry does not hold either.
    expect(
      result.missing.filter((item) => (item.packId ?? "custom") === "custom"),
    ).toEqual([
      { pluginId: "absent-from-policy" },
      { pluginId: "absent-from-pack", packId: "custom" },
    ]);
    // What the plan hands out is accepted by session creation as it is.
    expect(
      unknownPluginIds(
        [...result.defaultPluginIds, ...result.policy.requested],
        registry,
      ),
    ).toEqual([]);
  });
  it.each(["builtin", "community"] as const)(
    "keeps a %s request distinct from dependency and authorization resolution",
    async (source) => {
      registry.register(
        entry("core", {
          kind: "core",
          provides: [{ contract: "story@1", default: true }],
        }),
      );
      registry.register(
        entry(
          "replacement",
          { provides: ["story@1"], requires: ["helper@1"] },
          source,
        ),
      );
      registry.register(entry("dependency", { provides: ["helper@1"] }));
      const result = await plan({ requested: ["replacement"] });
      expect(result.defaultPluginIds).toEqual(["replacement"]);
      const resolved = resolveSessionPluginPlan(
        result.defaultPluginIds,
        registry,
      );
      if (source === "builtin")
        expect(resolved.active).toEqual(["replacement", "dependency"]);
      else {
        expect(resolved.active).toEqual(["core"]);
        expect(resolved.rejected).toContainEqual(
          expect.objectContaining({
            pluginId: "replacement",
            code: "approval-required",
          }),
        );
      }
    },
  );
  it("returns a coded 404 for an unknown world", async () => {
    const response = await app.request("/api/worlds/missing/plugin-plan");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "world_not_found" });
  });
});

describe("extension dependency session plans", () => {
  it("uses the same implementation metadata for server and client candidates", () => {
    const registry = createPluginRegistry();
    registry.register(
      entry("consumer", {
        requires: ["prompt.segment@1", "character.visual@1"],
      }),
    );
    registry.register(
      entry("claim", { provides: ["prompt.segment@1", "character.visual@1"] }),
    );
    registry.register(
      entry("prompt", {
        contributes: {
          prompt: [{ id: "note", content: "Note", position: "system" }],
        },
      }),
    );
    registry.register(
      entry("visual", {
        contributes: {
          extensions: [
            { point: "ui.slot@1", id: "visual", slot: "character.visual@1" },
          ],
        },
      }),
    );
    const server = resolveSessionPluginPlan(["consumer"], registry);
    const client = resolveSessionPlugins({
      requested: ["consumer"],
      plugins: [...registry.getAll().values()].map((plugin) => ({
        ...buildPluginSummary(plugin),
        authorized: true,
      })),
    });
    expect(server.active).toEqual(["consumer", "prompt", "visual"]);
    expect(client).toEqual(server);
  });
});
