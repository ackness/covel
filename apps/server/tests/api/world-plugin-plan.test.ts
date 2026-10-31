import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import path from "node:path";
import {
  createPluginRegistry,
  parsePluginMd,
  discoverPlugins,
  loadPluginDefinition,
  loadPluginSummary,
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
import { BUILTIN_PLUGIN_PACKS } from "../../src/config/plugin-packs.js";
import { buildPluginSummary } from "../../src/lib/plugin-descriptor.js";
import { worldPluginPlanRoutes } from "../../src/routes/api/worlds/plugin-plan.js";
import {
  resolveSessionPluginPlan,
  unknownPluginIds,
} from "../../src/routes/api/session/plugins.js";

describe("real bundled compositions", () => {
  it.each([false, true])(
    "resolves the catalogue and preserves one story with optional companions absent: %s",
    async (missingCompanions) => {
      const store = createMemoryStore();
      const registry = createPluginRegistry();
      for (const discovery of await discoverPlugins(
        path.resolve(import.meta.dirname, "../../../../plugins"),
      )) {
        if (
          missingCompanions &&
          ["character-agent", "turn-policy", "scene-stage"].includes(
            discovery.id,
          )
        )
          continue;
        const definition = await loadPluginDefinition(discovery);
        registry.register({
          id: discovery.id,
          source: "builtin",
          rootPath: discovery.rootPath,
          packageManifest: definition.packageManifest,
          manifests: definition.manifests,
          summary: await loadPluginSummary(discovery, "en-US", definition),
          status: "registered",
          loadedRuntimes: new Map(),
        });
      }
      registry.register(
        entry("visiting-policy", {
          contributes: { services: [{ contract: "turn-policy@1" }] },
        }),
      );
      const app = new Hono<Env>();
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("pluginRegistry", registry);
        await next();
      });
      app.route("/api/worlds", worldPluginPlanRoutes);
      try {
        expect(BUILTIN_PLUGIN_PACKS).toHaveLength(7);
        for (const pack of BUILTIN_PLUGIN_PACKS) {
          await store.createWorld({
            id: `pack-${pack.id}`,
            name: pack.id,
            description: "",
            metadata: {
              pluginPolicy: { preset: pack.id, plus: ["visiting-policy"] },
            },
            createdAt: "2026-10-31",
          });
          const response = await app.request(
            `/api/worlds/pack-${pack.id}/plugin-plan`,
          );
          expect(response.status).toBe(200);
          const plan = (await response.json()) as WorldPluginPlan;
          const selection = resolveSessionPluginPlan(
            [...plan.defaultPluginIds, ...plan.policy.plus],
            registry,
            { excluded: plan.packs[0]?.excluded },
          );
          expect(selection.active).toContain("visiting-policy");
          const stories = selection.active
            .flatMap((id) => registry.get(id)?.manifests ?? [])
            .filter(({ manifest }) => manifest.outputKind === "story");
          expect(stories, pack.id).toHaveLength(1);
          const expected = [
            "dialogue-mode",
            "ensemble-dialogue",
            "spectator",
          ].includes(pack.id)
            ? "chat-mode-narrator"
            : "narrator";
          expect(stories[0]?.manifest.pluginId, pack.id).toBe(expected);
          if (["dm-mode", "spectator"].includes(pack.id))
            expect(selection.active).not.toContain("char-creator");
          if (
            !missingCompanions &&
            ["ensemble-dialogue", "spectator"].includes(pack.id)
          )
            expect(selection.active).toEqual(
              expect.arrayContaining([
                "character-agent",
                "turn-policy",
                "scene-stage",
              ]),
            );
        }
      } finally {
        await store.close();
      }
    },
  );
});

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
      kind: fields.kind === "core" ? "core" : "plugin",
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
  it("starts from the preset pack, presented with the world's pitch, and adds plus", async () => {
    registry.register(entry("chat-mode-narrator"));
    const result = await plan({
      preset: "dialogue-mode",
      plus: ["traditional"],
      pitch: { label: { "zh-CN": "自定义", invalid: 42 }, reason: "Because" },
    });
    expect(result.selectedPackId).toBe("dialogue-mode");
    expect(result.policy).toEqual({
      preset: "dialogue-mode",
      plus: ["traditional"],
      requires: [],
    });
    expect(result.packs[0]).toMatchObject({
      id: "dialogue-mode",
      label: { "zh-CN": "自定义" },
      reason: "Because",
      source: "world",
      requested: ["chat-mode-narrator"],
    });
    expect(result.defaultPluginIds).toEqual([
      "chat-mode-narrator",
      "traditional",
    ]);
    // Core plugins join at session creation; the plan does not list them.
    expect(
      resolveSessionPluginPlan(result.defaultPluginIds, registry).active,
    ).toEqual(["chat-mode-narrator", "traditional", "core"]);
  });
  it("offers the built-in packs that packs names, the preset first", async () => {
    const result = await plan({
      preset: "low-cost",
      packs: ["dialogue-mode", "low-cost"],
    });
    expect(result.packs.map((pack) => pack.id)).toEqual([
      "low-cost",
      "dialogue-mode",
    ]);
    expect(result.packs[0]?.source).toBe("builtin");
  });
  it("offers every built-in pack and selects none without a preset", async () => {
    const result = await plan({ plus: ["dialogue"] });
    expect(result.selectedPackId).toBeUndefined();
    expect(result.packs.map((pack) => pack.id)).toEqual(
      BUILTIN_PLUGIN_PACKS.map((pack) => pack.id),
    );
    expect(result.defaultPluginIds).toEqual(["dialogue"]);
  });
  it("ignores a preset that is not a built-in pack", async () => {
    const result = await plan({ preset: "custom", plus: ["dialogue"] });
    expect(result.selectedPackId).toBeUndefined();
    expect(result.policy.preset).toBeUndefined();
    expect(result.defaultPluginIds).toEqual(["dialogue"]);
  });
  it("reports plugins the registry lacks instead of passing them on", async () => {
    const result = await plan({
      preset: "dialogue-mode",
      plus: ["dialogue", "absent-from-policy"],
    });
    expect(result.policy.plus).toEqual(["dialogue"]);
    expect(result.packs[0]?.requested).toEqual([]);
    expect(result.defaultPluginIds).toEqual(["dialogue"]);
    expect(result.missing).toContainEqual({ pluginId: "absent-from-policy" });
    expect(result.missing).toContainEqual({
      pluginId: "chat-mode-narrator",
      packId: "dialogue-mode",
    });
    // What the plan hands out is accepted by session creation as it is.
    expect(
      unknownPluginIds(
        [...result.defaultPluginIds, ...result.policy.plus],
        registry,
      ),
    ).toEqual([]);
  });

  it("offers only the narrator and excludes installed world-init in Narrative Only", async () => {
    registry.register(entry("narrator", { kind: "core" }));
    registry.register(
      entry("world-init", { kind: "core", provides: ["world.dimensions@1"] }),
    );
    const result = await plan({ preset: "narrative-only" });
    const pack = result.packs.find((item) => item.id === "narrative-only");
    expect(result.defaultPluginIds).toEqual(["narrator"]);
    expect(pack?.requested).toEqual(["narrator"]);
    // Turning off a plugin this host lacks changes nothing, so it is no miss.
    expect(pack?.excluded).toEqual(["world-init"]);
    expect(
      result.missing.filter((item) => item.packId === "narrative-only"),
    ).toEqual([]);
    expect(
      resolveSessionPluginPlan(result.defaultPluginIds, registry, {
        excluded: pack?.excluded,
      }).active,
    ).not.toContain("world-init");
  });

  it("activates one of two plugins that declare the same event topic", () => {
    const events = (file: string) => ({
      contributes: {
        events: [
          {
            topic: "scene.set",
            schema: `./schemas/${file}`,
            description: "",
            advertise: true,
          },
        ],
      },
    });
    registry.register(entry("stage", events("scene.json")));
    registry.register(entry("theatre", events("other-shape.json")));
    expect(buildPluginSummary(registry.get("stage")!).eventTopics).toEqual([
      "scene.set",
    ]);
    const plan = resolveSessionPluginPlan(["stage", "theatre"], registry);
    // The second declaration never reaches the session, so no event of it is
    // validated against the first one's schema.
    expect(plan.active).toEqual(["stage", "core"]);
    expect(plan.rejected).toEqual([
      expect.objectContaining({
        pluginId: "theatre",
        code: "event-topic-conflict",
        reason: expect.stringContaining("stage and theatre"),
      }),
    ]);
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
      const result = await plan({ plus: ["replacement"] });
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
