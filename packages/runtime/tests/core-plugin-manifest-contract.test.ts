import { describe, expect, it } from "vitest";
import path from "node:path";
import type { RuntimeManifest } from "@covel/shared";
import { discoverPlugins, loadPluginManifest } from "@covel/plugin-loader";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");

async function loadRuntimeManifests(): Promise<Map<string, RuntimeManifest>> {
  const discoveries = await discoverPlugins(PLUGINS_DIR);
  const manifests: RuntimeManifest[] = [];
  for (const discovery of discoveries) {
    const parsed = await loadPluginManifest(discovery);
    manifests.push(...parsed.map((plugin) => plugin.manifest));
  }
  return new Map(manifests.map((manifest) => [manifest.name, manifest]));
}

function requireRuntime(
  manifests: ReadonlyMap<string, RuntimeManifest>,
  runtimeId: string,
): RuntimeManifest {
  const manifest = manifests.get(runtimeId);
  if (!manifest) {
    throw new Error(`Missing runtime manifest: ${runtimeId}`);
  }
  return manifest;
}

describe("core plugin manifest contract", () => {
  it("keeps the Pre-Game chain in framework scheduling order", async () => {
    const manifests = await loadRuntimeManifests();
    const pregame = requireRuntime(manifests, "pregame");
    const schemaGen = requireRuntime(manifests, "world-init/schema-gen");
    const playerInit = requireRuntime(manifests, "char-creator/player-init");

    expect(pregame).toMatchObject({
      pluginType: "core-plugin",
      priority: 10,
      runtimeType: "function",
      handler: "./handler.js",
      trigger: { type: "scheduled", interval: 1, maxTriggerCount: 1 },
    });
    expect(schemaGen).toMatchObject({
      pluginType: "core-plugin",
      priority: 40,
      model: "plugin",
      guard: "../../guard.js",
      trigger: { type: "scheduled", interval: 1, maxTriggerCount: 1 },
    });
    expect(schemaGen.tools?.local).toEqual([
      "./tools/set-world-schema.js",
      "./tools/set-world-entries-batch.js",
    ]);
    expect(schemaGen.tools?.builtin).toEqual([
      "plugin-data-get",
      "plugin-data-list",
    ]);

    expect(playerInit).toMatchObject({
      pluginType: "core-plugin",
      priority: 50,
      model: "plugin",
      guard: "./guard.js",
      trigger: { type: "auto" },
      upstreamRequired: ["pregame", "world-init/schema-gen"],
    });
    expect(playerInit.input?.inject).toEqual([
      {
        kind: "runtime",
        from: "pregame",
        field: "narrativeOutput",
        as: "<pregame-opening>",
      },
    ]);

    const pregamePriorities = [pregame, schemaGen, playerInit].map(
      (manifest) => manifest.priority,
    );
    expect(pregamePriorities).toEqual([10, 40, 50]);
    expect(
      pregamePriorities.every((priority) => priority >= 0 && priority <= 99),
    ).toBe(true);
  });

  it("keeps the main-loop DAG around narrator and downstream plugins", async () => {
    const manifests = await loadRuntimeManifests();
    const retriever = requireRuntime(manifests, "npc-graph/rag-retriever");
    const narrator = requireRuntime(manifests, "narrator");
    const downstreamIds = [
      "guide",
      "codex",
      "npc-graph/extractor",
      "char-creator/character-tracker",
    ];
    const downstreams = downstreamIds.map((id) =>
      requireRuntime(manifests, id),
    );

    expect(retriever).toMatchObject({
      pluginType: "plugin",
      priority: 400,
      runtimeType: "function",
      handler: "./handler.js",
      trigger: { type: "scheduled", interval: 1 },
    });

    expect(narrator).toMatchObject({
      pluginType: "core-plugin",
      priority: 500,
      model: "story",
      outputKind: "story",
      trigger: { type: "auto" },
    });
    expect(narrator.input?.inject).toEqual([
      {
        kind: "runtime",
        from: "npc-graph/rag-retriever",
        field: "npcContext",
        as: "npc-relationships",
      },
    ]);
    expect(narrator.tools?.builtin).toEqual(["world-dimension-get"]);

    for (const downstream of downstreams) {
      expect(downstream.priority).toBe(600);
    }

    // guide is engine-agnostic: it gates on the `narrative-engine` capability
    // (discovering whichever narrative engine the current mode loaded) and
    // injects from both known engines so it works under narrator OR
    // chat-mode-narrator.
    const guide = requireRuntime(manifests, "guide");
    expect(guide.upstreamRequired).toEqual([
      { capability: "narrative-engine" },
    ]);
    for (const engine of ["narrator", "chat-mode-narrator"]) {
      expect(guide.input?.inject).toContainEqual({
        kind: "runtime",
        from: engine,
        field: "narrativeOutput",
        as: expect.any(String),
      });
    }

    // The remaining downstreams stay bound to narrator by name.
    for (const downstream of downstreams.filter((m) => m.name !== "guide")) {
      expect(downstream.upstreamRequired).toEqual(["narrator"]);
      expect(downstream.input?.inject).toContainEqual({
        kind: "runtime",
        from: "narrator",
        field: "narrativeOutput",
        as: expect.any(String),
      });
    }
    expect(downstreams.map((manifest) => manifest.model)).toEqual([
      "plugin",
      "plugin",
      "plugin",
      "plugin",
    ]);
  });

  it("keeps manual Chat Mode utilities outside automatic scheduling", async () => {
    const manifests = await loadRuntimeManifests();
    const manualUtilityIds = [
      "character-blueprint",
      "character-presence",
      "player-identity",
      "living-world-rules",
    ];

    for (const runtimeId of manualUtilityIds) {
      const manifest = requireRuntime(manifests, runtimeId);
      expect(manifest.trigger).toMatchObject({ type: "manual" });
      expect(manifest.priority).toBeUndefined();
    }
  });

  it("keeps framework-controlled core plugins enabled as core-plugin manifests", async () => {
    const manifests = await loadRuntimeManifests();
    const coreRuntimeIds = [
      "pregame",
      "world-init/schema-gen",
      "char-creator/player-init",
      "narrator",
      "char-creator/character-tracker",
    ];

    for (const runtimeId of coreRuntimeIds) {
      expect(requireRuntime(manifests, runtimeId).pluginType).toBe(
        "core-plugin",
      );
    }
  });
});
