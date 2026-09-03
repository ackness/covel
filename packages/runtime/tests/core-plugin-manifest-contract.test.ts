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
    // schema-gen writes the world schema during setup; it has no reason to
    // read its own plugin-data back, and its prompt never mentioned the read
    // tools it used to declare.
    expect(schemaGen.tools?.builtin).toBeUndefined();

    expect(playerInit).toMatchObject({
      pluginType: "core-plugin",
      stage: "setup",
      model: "plugin",
      guard: "./guard.js",
      trigger: { type: "auto" },
      requireToolUse: true,
      completeAfterTools: ["create-form"],
      maxSteps: 2,
      maxRetries: 0,
      // Turn-scoped needs carry both the intra-stage order and the same-turn
      // gate; the explicit stage picks the band.
      needs: ["pregame", "world-init/schema-gen"],
    });
    expect(playerInit.input?.inject).toEqual([
      {
        kind: "runtime",
        from: "pregame",
        field: "narrativeOutput",
        as: "<pregame-opening>",
      },
      {
        kind: "runtime",
        from: "world-init/schema-gen",
        field: "worldSchema",
        as: "<same-turn-world-schema>",
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
    const chatModeNarrator = requireRuntime(manifests, "chat-mode-narrator");
    const rawDownstreamIds = ["guide", "char-creator/character-tracker"];
    const structuredDownstreamIds = [
      "codex",
      "npc-graph/extractor",
      "core-quest",
      "affinity",
      "inventory",
    ];
    const rawDownstreams = rawDownstreamIds.map((id) =>
      requireRuntime(manifests, id),
    );
    const structuredDownstreams = structuredDownstreamIds.map((id) =>
      requireRuntime(manifests, id),
    );
    const worldIr = requireRuntime(manifests, "world-ir");

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
      {
        kind: "runtime",
        from: "dice-check/roller",
        field: "checkContext",
        as: "<check-results>",
      },
    ]);
    expect(narrator.tools?.builtin).toEqual([
      "world-dimension-get",
      "memory-search",
      "emit-event",
    ]);
    expect(chatModeNarrator.tools?.builtin).toEqual([
      "world-dimension-get",
      "memory-search",
      "emit-event",
    ]);

    const guide = requireRuntime(manifests, "guide");
    expect(guide).toMatchObject({
      requireToolUse: true,
      completeAfterTools: ["generate-guide"],
      maxSteps: 2,
      maxRetries: 0,
    });

    for (const downstream of [
      ...rawDownstreams,
      worldIr,
      ...structuredDownstreams,
    ]) {
      expect(getRuntimeSpec(downstream).stage).toBe("post-turn");
    }

    // Presentation and tracker runtimes that still need the prose remain
    // engine-agnostic raw narrative consumers.
    for (const downstream of rawDownstreams) {
      expect(downstream.needs).toEqual([{ capability: "narrative-engine" }]);
      for (const engine of ["narrator", "chat-mode-narrator"]) {
        expect(downstream.input?.inject).toContainEqual({
          kind: "runtime",
          from: engine,
          field: "narrativeOutput",
          as: expect.any(String),
        });
      }
    }

    // The shared extractor owns the only typed narrative-to-WorldIR
    // conversion. State plugins consume its same-turn typed output and no
    // longer duplicate raw narrator injections.
    expect(worldIr.capabilities).toContain("world-ir-provider");
    expect(worldIr.inputs?.narrative).toMatchObject({
      from: { capability: "narrative-engine", cardinality: "one" },
      select: "/narrativeOutput",
      required: true,
    });
    expect(worldIr.output).toEqual({
      schema: "covel://world/ir/v1",
      recordAs: "world-ir-v1",
    });
    expect(worldIr.tools?.plugin).toEqual(["submit-world-facts"]);
    expect(worldIr.requireToolUse).toBe(true);
    expect(worldIr.completeAfterTools).toEqual(["submit-world-facts"]);
    for (const downstream of structuredDownstreams) {
      expect(downstream.needs).toBeUndefined();
      expect(downstream.inputs?.worldIR).toMatchObject({
        from: { capability: "world-ir-provider", cardinality: "one" },
        accepts: "covel://world/ir/v1",
        required: true,
      });
      expect(
        downstream.input?.inject?.some(
          (inject) =>
            inject.kind === "runtime" &&
            ["narrator", "chat-mode-narrator"].includes(inject.from),
        ) ?? false,
      ).toBe(false);
    }

    expect(requireRuntime(manifests, "affinity").completeAfterTools).toEqual([
      "update-affinity",
    ]);
    expect(requireRuntime(manifests, "inventory").completeAfterTools).toEqual([
      "update-inventory",
    ]);
    expect(requireRuntime(manifests, "core-quest").completeAfterTools).toEqual([
      "upsert-quests",
    ]);

    expect(
      [...rawDownstreams, worldIr, ...structuredDownstreams].map(
        (manifest) => manifest.model,
      ),
    ).toEqual([
      "plugin",
      "plugin",
      "plugin",
      "plugin",
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
