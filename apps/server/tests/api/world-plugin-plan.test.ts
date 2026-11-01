import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { loadSingleWorld } from "../../src/world-seed-loader.js";
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
  resolveI18nText,
  worldPluginPlanSchema,
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
              plugins: [`pack:${pack.id}`, "plugin:visiting-policy"],
            },
            createdAt: "2026-10-31",
          });
          const response = await app.request(
            `/api/worlds/pack-${pack.id}/plugin-plan`,
          );
          expect(response.status).toBe(200);
          const plan = (await response.json()) as WorldPluginPlan;
          const selection = resolveSessionPluginPlan(
            [...plan.defaultPluginIds, ...plan.selection.requestedPluginIds],
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
    plugins: string[],
    pluginPitch?: Record<string, unknown>,
    overlay?: Record<string, unknown>,
  ): Promise<WorldPluginPlan> {
    const dir = await mkdtemp(path.join(tmpdir(), "world-plan-"));
    try {
      await writeFile(
        path.join(dir, "world.yaml"),
        stringify({
          id: "world",
          name: "The long watch",
          summary: "Keep the relay alive.",
          defaultLocale: "en-US",
          tags: ["frontier", "mystery"],
          plugins,
          ...(pluginPitch ? { pluginPitch } : {}),
        }),
      );
      await writeFile(
        path.join(dir, "WORLD.md"),
        "# Watch\nPublic lore.\n<!-- narrator-only -->\nSECRET_NARRATOR_SENTINEL\n<!-- /narrator-only -->\n",
      );
      if (overlay) {
        await writeFile(path.join(dir, "world.zh-CN.yaml"), stringify(overlay));
        await writeFile(path.join(dir, "WORLD.zh-CN.md"), "# 守夜\n公开设定。");
      }
      const world = await loadSingleWorld(dir);
      expect(world).not.toBeNull();
      expect(world?.lore).toContain("SECRET_NARRATOR_SENTINEL");
      await store.upsertWorld({
        ...world!,
        metadata: {
          ...world!.metadata,
          hiddenContent: { secret: "SECRET_HIDDEN_SENTINEL" },
        },
      });
      return await fetchPlan();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async function fetchPlan(): Promise<WorldPluginPlan> {
    const response = await app.request("/api/worlds/world/plugin-plan");
    expect(response.status).toBe(200);
    return worldPluginPlanSchema.parse(await response.json());
  }
  it("loads prefixed YAML and derives pitch only from translated public metadata", async () => {
    registry.register(entry("chat-mode-narrator"));
    const result = await plan(
      ["pack:dialogue-mode", "plugin:traditional"],
      undefined,
      {
        name: "漫长守夜",
        summary: "守住中继站。",
      },
    );
    expect(result.selection).toEqual({
      requestedPluginIds: ["traditional"],
      requiredContracts: [],
      requiredDataContracts: [],
    });
    expect(result.selectedPackId).toBe("dialogue-mode");
    const pack = result.packs[0]!;
    expect(resolveI18nText(pack.label, "en-US")).toBe("The long watch");
    expect(resolveI18nText(pack.label, "zh-CN")).toBe("漫长守夜");
    expect(resolveI18nText(pack.description!, "zh-CN")).toBe("守住中继站。");
    expect(pack.tags).toEqual(["frontier", "mystery"]);
    expect(pack.reason).toBeUndefined();
    expect(result.defaultPluginIds).toEqual([
      "chat-mode-narrator",
      "traditional",
    ]);
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    const world = (await store.getWorld("world"))!;
    expect(world.metadata?.pluginPitch).toBeUndefined();
    await store.upsertWorld({
      ...world,
      description: "A new public summary",
      tags: ["rescue"],
      metadata: world.metadata,
    });
    const fresh = await fetchPlan();
    expect(resolveI18nText(fresh.packs[0]!.description!, "en-US")).toBe(
      "A new public summary",
    );
    expect(fresh.packs[0]?.tags).toEqual(["rescue"]);
  });
  it("defaults each omitted pitch field independently and preserves explicit translations", async () => {
    const result = await plan(
      ["pack:dialogue-mode"],
      { label: "Watch" },
      { pluginPitch: { label: "守夜" } },
    );
    expect(resolveI18nText(result.packs[0]!.label, "zh-CN")).toBe("守夜");
    expect(resolveI18nText(result.packs[0]!.label, "fr-FR")).toBe("Watch");
    expect(result.packs[0]?.description).toBe("Keep the relay alive.");
  });
  it("orders named alternatives and retains every host pack", async () => {
    const result = await plan(["pack:low-cost", "pack:dialogue-mode"]);
    expect(result.packs.slice(0, 2).map(({ id }) => id)).toEqual([
      "low-cost",
      "dialogue-mode",
    ]);
    expect(result.packs).toHaveLength(BUILTIN_PLUGIN_PACKS.length);
    expect(result.packs[0]?.source).toBe("world");
  });
  it.each([[[]], [["plugin:dialogue"]]])(
    "selects no pack without a pack reference: %j",
    async (plugins) => {
      const result = await plan(plugins);
      expect(result.selectedPackId).toBeUndefined();
      expect(result.packs.map(({ id }) => id)).toEqual(
        BUILTIN_PLUGIN_PACKS.map(({ id }) => id),
      );
      expect(result.defaultPluginIds).toEqual(
        plugins.length ? ["dialogue"] : [],
      );
    },
  );
  it("reports an unknown first pack without selecting the second", async () => {
    const result = await plan([
      "pack:custom",
      "pack:dialogue-mode",
      "plugin:dialogue",
    ]);
    expect(result.selectedPackId).toBeUndefined();
    expect(result.defaultPluginIds).toEqual(["dialogue"]);
    expect(result.diagnostics).toContainEqual({
      code: "unknown-pack",
      path: "plugins[0]",
      reference: "pack:custom",
      packId: "custom",
    });
  });
  it("reports missing independent and pack requests without submitting unknown IDs", async () => {
    const result = await plan([
      "pack:dialogue-mode",
      "plugin:dialogue",
      "plugin:absent",
    ]);
    expect(result.selection.requestedPluginIds).toEqual(["dialogue"]);
    expect(result.packs[0]?.requested).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        { code: "missing-plugin", path: "plugins[2]", pluginId: "absent" },
        {
          code: "missing-plugin",
          path: "plugins[0]",
          pluginId: "chat-mode-narrator",
          packId: "dialogue-mode",
        },
      ]),
    );
    expect(unknownPluginIds(result.defaultPluginIds, registry)).toEqual([]);
  });
  it("keeps the selected pack's exclusions", async () => {
    registry.register(entry("narrator", { kind: "core" }));
    registry.register(
      entry("world-init", { kind: "core", provides: ["world.dimensions@1"] }),
    );
    const result = await plan(["pack:narrative-only"]);
    const pack = result.packs.find(({ id }) => id === "narrative-only");
    expect(pack?.excluded).toEqual(["world-init"]);
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
      const result = await plan(["plugin:replacement"]);
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
