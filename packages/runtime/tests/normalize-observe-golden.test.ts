/**
 * Observe-only golden tests for the manifest → NormalizedRuntimeSpec
 * normalization.
 *
 * The normalize layer is not consumed by production scheduling yet. These
 * tests characterize the mapping over the real bundled plugin set and
 * assert it is consistent with what the live scheduler does today, so the
 * later switch-over can rely on "same inputs → same order" evidence.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import type { NormalizedRuntimeSpec, RuntimeManifest } from "@covel/shared";
import { STAGE_ORDER } from "@covel/shared";
import {
  discoverPlugins,
  loadPluginManifest,
  normalizeRuntimeManifest,
} from "@covel/plugin-loader";
import { scheduleByPriority } from "../src/schedule/scheduler.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");

async function loadAllManifests(): Promise<readonly RuntimeManifest[]> {
  const discoveries = await discoverPlugins(PLUGINS_DIR);
  const manifests: RuntimeManifest[] = [];
  for (const discovery of discoveries) {
    const plugins = await loadPluginManifest(discovery);
    manifests.push(...plugins.map((plugin) => plugin.manifest));
  }
  return manifests;
}

function effectiveTriggerType(manifest: RuntimeManifest): string {
  return manifest.trigger?.type ?? "auto";
}

function isStageSourceManifest(manifest: RuntimeManifest): boolean {
  const type = effectiveTriggerType(manifest);
  return type === "auto" || type === "scheduled";
}

function stageIndex(spec: NormalizedRuntimeSpec): number {
  return spec.stage === undefined ? -1 : STAGE_ORDER.indexOf(spec.stage);
}

function specById(
  specs: readonly NormalizedRuntimeSpec[],
): ReadonlyMap<string, NormalizedRuntimeSpec> {
  return new Map(specs.map((spec) => [spec.id, spec]));
}

function requireSpec(
  specs: ReadonlyMap<string, NormalizedRuntimeSpec>,
  id: string,
): NormalizedRuntimeSpec {
  const spec = specs.get(id);
  if (!spec) throw new Error(`Missing normalized spec: ${id}`);
  return spec;
}

describe("normalize golden (bundled plugin set)", () => {
  it("derives a stage exactly for band-schedulable runtimes", async () => {
    const manifests = await loadAllManifests();
    for (const manifest of manifests) {
      const spec = normalizeRuntimeManifest(manifest);
      // Mirror of the live scheduler contract: undefined priority is the
      // UI-only idiom (never scheduled), and only auto/scheduled runtimes
      // enter the stage pipeline. Reserved triggers are disabled outright.
      const expectStage =
        manifest.priority !== undefined &&
        isStageSourceManifest(manifest) &&
        spec.disabledReason === undefined;
      expect(
        spec.stage !== undefined,
        `${manifest.name}: stage presence mismatch`,
      ).toBe(expectStage);
      // legacyOrder always carries the raw priority for compat consumers
      // (event fan-out ordering included), independent of stage.
      expect(spec.legacyOrder).toBe(manifest.priority);
    }
  });

  it("orders the main loop identically to the live priority scheduler", async () => {
    const manifests = await loadAllManifests();
    // The live scheduler band-filters by priority alone; trigger gating
    // happens later in shouldTrigger. Compare on the subset that actually
    // enters the stage pipeline (auto/scheduled), where ordering is the
    // contract that must survive the migration.
    const stageSource = manifests.filter(
      (manifest) =>
        isStageSourceManifest(manifest) && manifest.priority !== undefined,
    );

    const liveOrder = scheduleByPriority(stageSource, 1).flatMap((group) =>
      group.runtimes.map((runtime) => runtime.name),
    );

    const irOrder = stageSource
      .map((manifest) => normalizeRuntimeManifest(manifest))
      .filter((spec) => spec.stage !== undefined && spec.stage !== "setup")
      .toSorted(
        (a, b) =>
          stageIndex(a) - stageIndex(b) ||
          (a.legacyOrder ?? 0) - (b.legacyOrder ?? 0),
      )
      .map((spec) => spec.id);

    expect(irOrder).toEqual(liveOrder);
  });

  it("orders the pre-game band identically to the live priority scheduler", async () => {
    const manifests = await loadAllManifests();
    const stageSource = manifests.filter(
      (manifest) =>
        isStageSourceManifest(manifest) && manifest.priority !== undefined,
    );

    const liveOrder = scheduleByPriority(stageSource, 0).flatMap((group) =>
      group.runtimes.map((runtime) => runtime.name),
    );

    const irOrder = stageSource
      .map((manifest) => normalizeRuntimeManifest(manifest))
      .filter((spec) => spec.stage === "setup")
      .toSorted((a, b) => (a.legacyOrder ?? 0) - (b.legacyOrder ?? 0))
      .map((spec) => spec.id);

    expect(irOrder).toEqual(liveOrder);
  });

  it("maps the documented core chain onto the new declaration surface", async () => {
    const manifests = await loadAllManifests();
    const specs = specById(manifests.map(normalizeRuntimeManifest));

    const pregame = requireSpec(specs, "pregame");
    expect(pregame.stage).toBe("setup");
    // Legacy setup idiom `scheduled + interval: 1 + maxTriggerCount: 1`
    // folds to auto with the attempt budget preserved.
    expect(pregame.declaredTrigger.type).toBe("auto");
    expect(pregame.declaredTrigger.interval).toBeUndefined();
    expect(pregame.declaredTrigger.maxTriggerCount).toBe(1);
    expect(pregame.provenance.legacyFields).toContain(
      "trigger:scheduled-as-auto",
    );

    const schemaGen = requireSpec(specs, "world-init/schema-gen");
    expect(schemaGen.stage).toBe("setup");
    expect(schemaGen.declaredTrigger.type).toBe("auto");

    const playerInit = requireSpec(specs, "char-creator/player-init");
    expect(playerInit.stage).toBe("setup");
    expect(playerInit.deps.needs).toEqual(["pregame", "world-init/schema-gen"]);
    expect(playerInit.provenance.legacyFields).toContain("upstreamRequired");

    const retriever = requireSpec(specs, "npc-graph/rag-retriever");
    expect(retriever.stage).toBe("pre-turn");
    // Non-setup scheduled runtimes keep their scheduled trigger unchanged.
    expect(retriever.declaredTrigger.type).toBe("scheduled");

    const narrator = requireSpec(specs, "narrator");
    expect(narrator.stage).toBe("narrative");
    expect(requireSpec(specs, "chat-mode-narrator").stage).toBe("narrative");

    for (const id of [
      "guide",
      "codex",
      "npc-graph/extractor",
      "char-creator/character-tracker",
    ]) {
      const spec = requireSpec(specs, id);
      expect(spec.stage).toBe("post-turn");
      expect(spec.deps.needs).toEqual([{ capability: "narrative-engine" }]);
    }
  });

  it("keeps event and manual runtimes stage-less with legacyOrder preserved", async () => {
    const manifests = await loadAllManifests();
    const specs = specById(manifests.map(normalizeRuntimeManifest));

    const resolver = requireSpec(specs, "scene-stage/resolver");
    expect(resolver.stage).toBeUndefined();
    expect(resolver.declaredTrigger.type).toBe("event");
    expect(resolver.legacyOrder).toBe(460);

    const backgroundGen = requireSpec(specs, "scene-stage/background-gen");
    expect(backgroundGen.stage).toBeUndefined();
    expect(backgroundGen.legacyOrder).toBe(900);

    for (const id of [
      "character-blueprint",
      "character-presence",
      "player-identity",
      "living-world-rules",
      "memory",
    ]) {
      const spec = requireSpec(specs, id);
      expect(spec.stage).toBeUndefined();
      expect(spec.declaredTrigger.type).toBe("manual");
      expect(spec.legacyOrder).toBeUndefined();
    }
  });

  it("defaults new contract fields for every legacy manifest", async () => {
    const manifests = await loadAllManifests();
    for (const manifest of manifests) {
      const spec = normalizeRuntimeManifest(manifest);
      expect(spec.resultFormat).toBe("legacy");
      expect(spec.suspensionSafe).toBe(false);
      expect(spec.bindings).toEqual({});
      expect(spec.exportBindings).toEqual({});
      expect(spec.httpPermissions).toEqual([]);
      expect(spec.legacyJobViews).toEqual([]);
      expect(spec.disabledReason).toBeUndefined();
      expect(spec.backgroundWhenDetached).toBe(
        manifest.execution === "background",
      );
    }
  });
});
