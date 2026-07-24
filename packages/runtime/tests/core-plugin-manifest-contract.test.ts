import { describe, expect, it } from "vitest";
import path from "node:path";
import type { RuntimeManifest } from "@covel/shared";
import { getRuntimeSpec } from "@covel/shared";
import { discoverPlugins, loadPluginManifest } from "@covel/plugin-loader";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");

interface LoadedPluginMd {
  readonly manifest: RuntimeManifest;
  readonly promptTemplate: string;
}

async function loadParsedPlugins(): Promise<readonly LoadedPluginMd[]> {
  const discoveries = await discoverPlugins(PLUGINS_DIR);
  const parsed: LoadedPluginMd[] = [];
  for (const discovery of discoveries) {
    const plugins = await loadPluginManifest(discovery);
    parsed.push(
      ...plugins.map((plugin) => ({
        manifest: plugin.manifest,
        promptTemplate: plugin.promptTemplate ?? "",
      })),
    );
  }
  return parsed;
}

async function loadRuntimeManifests(): Promise<Map<string, RuntimeManifest>> {
  const parsed = await loadParsedPlugins();
  return new Map(parsed.map(({ manifest }) => [manifest.name, manifest]));
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
      stage: "setup",
      runtimeType: "function",
      handler: "./handler.js",
      trigger: { type: "auto", maxTriggerCount: 1 },
    });
    expect(schemaGen).toMatchObject({
      pluginType: "core-plugin",
      stage: "setup",
      after: ["pregame"],
      model: "plugin",
      guard: "../../guard.js",
      trigger: { type: "auto", maxTriggerCount: 1 },
    });
    expect(schemaGen.tools?.plugin).toEqual([
      "set-world-schema",
      "set-world-entries-batch",
    ]);
    expect(schemaGen.tools?.builtin).toEqual([
      "plugin-data-get",
      "plugin-data-list",
    ]);

    expect(playerInit).toMatchObject({
      pluginType: "core-plugin",
      stage: "setup",
      model: "plugin",
      guard: "./guard.js",
      trigger: { type: "auto" },
      // Single-declared now: turn-scoped needs replace upstreamRequired (order +
      // same-turn gate). priority removed (explicit stage).
      needs: ["pregame", "world-init/schema-gen"],
    });
    expect(playerInit.priority).toBeUndefined();
    expect(playerInit.upstreamRequired).toBeUndefined();
    expect(playerInit.input?.inject).toEqual([
      {
        kind: "runtime",
        from: "pregame",
        field: "narrativeOutput",
        as: "<pregame-opening>",
      },
    ]);

    // All three resolve to the setup stage. pregame / schema-gen still ride the
    // priority-band derivation (the loader forbids `stage: setup` on their
    // scheduled trigger); player-init declares `stage` explicitly.
    for (const manifest of [pregame, schemaGen, playerInit]) {
      expect(getRuntimeSpec(manifest).stage).toBe("setup");
    }
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
      stage: "pre-turn",
      runtimeType: "function",
      handler: "./handler.js",
      trigger: { type: "scheduled", interval: 1 },
    });

    expect(narrator).toMatchObject({
      pluginType: "core-plugin",
      stage: "narrative",
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
    expect(narrator.tools?.builtin).toEqual([
      "world-dimension-get",
      "emit-event",
    ]);

    for (const downstream of downstreams) {
      expect(getRuntimeSpec(downstream).stage).toBe("post-turn");
    }

    // Every narrator-downstream runtime is engine-agnostic : it gates
    // on the `narrative-engine` capability (discovering whichever narrative
    // engine the current mode loaded) and injects from both known engines so
    // it works under narrator OR chat-mode-narrator. An exact `narrator`
    // upstream would permanently skip these runtimes in dialogue mode.
    // Single-declared now: the turn-scoped `needs` capability entry (no
    // upstreamRequired alias).
    for (const downstream of downstreams) {
      expect(downstream.needs).toEqual([{ capability: "narrative-engine" }]);
      expect(downstream.upstreamRequired).toBeUndefined();
      for (const engine of ["narrator", "chat-mode-narrator"]) {
        expect(downstream.input?.inject).toContainEqual({
          kind: "runtime",
          from: engine,
          field: "narrativeOutput",
          as: expect.any(String),
        });
      }
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

  it("never inlines player input or upstream runtime output into PLUGIN bodies", async () => {
    const parsed = await loadParsedPlugins();

    for (const { manifest, promptTemplate } of parsed) {
      // Player input rides the user role exclusively. A `{{ player.message }}`
      // interpolation would copy it un-escaped into the system prompt.
      expect(
        promptTemplate.includes("{{ player.message }}"),
        `${manifest.name}: PLUGIN body must not interpolate {{ player.message }} `,
      ).toBe(false);

      // When a runtime declares an `input.inject` for upstream output,
      // the framework already appends an escaped XML block (segment 5). A raw
      // `{{ inputs.* }}` interpolation in the body would inject a SECOND,
      // un-escaped copy of the same data.
      expect(
        /\{\{\s*inputs\./.test(promptTemplate),
        `${manifest.name}: PLUGIN body must not raw-interpolate {{ inputs.* }} — use input.inject `,
      ).toBe(false);
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
