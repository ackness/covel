/**
 * Golden tests for the manifest → NormalizedRuntimeSpec normalization AND the
 * stage-driven production schedule over the real bundled plugin set.
 *
 * Production scheduling now consumes the IR: `stage` selects the band and the
 * DAG orders within it. These tests characterize the mapping over the bundled
 * set and pin the resulting execution order as a fixed sequence, so the switch
 * off numeric priority is guarded byte-for-byte.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import type { NormalizedRuntimeSpec, RuntimeManifest } from "@covel/shared";
import { isSetupRuntime } from "@covel/shared";
import {
  discoverPlugins,
  loadPluginManifest,
  normalizeRuntimeManifest,
} from "@covel/plugin-loader";
import {
  deriveConservativeSetupEdges,
  scheduleByDag,
} from "../src/schedule/dag-scheduler.js";

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

function isStageSourceManifest(manifest: RuntimeManifest): boolean {
  const type = manifest.trigger?.type ?? "auto";
  return type === "auto" || type === "scheduled";
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

/**
 * Flatten a DAG plan into level-groups of runtime names. The conservative
 * legacy-order chain applies to the setup stage only (mirrors the real
 * scheduler: setup passes `deriveConservativeSetupEdges`, main-loop stages do
 * not).
 */
function levelsOf(
  runtimes: readonly RuntimeManifest[],
  conservative = false,
): readonly string[][] {
  const plan = scheduleByDag(
    runtimes,
    conservative ? deriveConservativeSetupEdges(runtimes) : undefined,
  );
  return plan.groups.map((g) => g.runtimes.map((r) => r.name));
}

describe("normalize golden (bundled plugin set)", () => {
  it("derives a stage exactly for band-schedulable runtimes", async () => {
    const manifests = await loadAllManifests();
    for (const manifest of manifests) {
      const spec = normalizeRuntimeManifest(manifest);
      // undefined priority is the UI-only idiom (never scheduled), and only
      // auto/scheduled runtimes with a stage (explicit or priority-derived)
      // enter the pipeline. Reserved triggers are disabled outright.
      const expectStage =
        (manifest.stage !== undefined ||
          (manifest.priority !== undefined &&
            isStageSourceManifest(manifest))) &&
        spec.disabledReason === undefined;
      expect(
        spec.stage !== undefined,
        `${manifest.name}: stage presence mismatch`,
      ).toBe(expectStage);
    }
  });

  it("orders the setup stage byte-identically (pregame → schema-gen → player-init)", async () => {
    const manifests = await loadAllManifests();
    const setup = manifests.filter(isSetupRuntime);
    // The conservative legacy-order chain keeps pregame → schema-gen serial
    // (no declared edge between them); player-init's turn-scoped `needs` order
    // it after both. This is the old priority order (10 → 40 → 50).
    expect(levelsOf(setup, true)).toEqual([
      ["pregame"],
      ["world-init/schema-gen"],
      ["char-creator/player-init"],
    ]);
  });

  it("parallelizes the post-turn stage (independent narrative downstreams)", async () => {
    const manifests = await loadAllManifests();
    const specs = specById(manifests.map(normalizeRuntimeManifest));
    const postTurn = manifests.filter(
      (m) => specs.get(m.name)?.stage === "post-turn",
    );
    // Every post-turn runtime depends only on the narrative engine, which sits
    // in the earlier `narrative` stage (out of this stage's DAG scope). So they
    // form a single parallel level, ordered by name for a stable trace.
    const levels = levelsOf(postTurn);
    expect(levels).toHaveLength(1);
    // One level, ordered by name (a stable trace order; the level runs parallel).
    expect(levels[0]).toEqual([
      "branch-reply",
      "char-creator/character-tracker",
      "codex",
      "guide",
      "npc-graph/extractor",
      "scene-prompts",
    ]);
  });

  it("maps the documented core chain onto the single-declaration surface", async () => {
    const manifests = await loadAllManifests();
    const specs = specById(manifests.map(normalizeRuntimeManifest));

    // pregame / schema-gen are the retained exception: the loader forbids
    // `stage: setup` on their `scheduled`/`interval` trigger, so they keep the
    // legacy setup idiom and let normalize DERIVE the stage (hence
    // `priority:stage` in provenance). The idiom folds to auto with the attempt
    // budget preserved.
    const pregame = requireSpec(specs, "pregame");
    expect(pregame.stage).toBe("setup");
    expect(pregame.declaredTrigger.type).toBe("auto");
    expect(pregame.declaredTrigger.interval).toBeUndefined();
    expect(pregame.declaredTrigger.maxTriggerCount).toBe(1);
    expect(pregame.provenance.legacyFields).toContain(
      "trigger:scheduled-as-auto",
    );
    expect(pregame.provenance.legacyFields).toContain("priority:stage");

    const schemaGen = requireSpec(specs, "world-init/schema-gen");
    expect(schemaGen.stage).toBe("setup");
    expect(schemaGen.declaredTrigger.type).toBe("auto");
    expect(schemaGen.provenance.legacyFields).toContain("priority:stage");

    // player-init: single-declared now — explicit `stage: setup` and turn-scoped
    // `needs` (priority + upstreamRequired removed). The turn-scoped needs are
    // the DAG edge + same-turn gate.
    const playerInit = requireSpec(specs, "char-creator/player-init");
    expect(playerInit.stage).toBe("setup");
    expect(playerInit.provenance.legacyFields).not.toContain("priority:stage");
    expect(playerInit.provenance.legacyFields).not.toContain(
      "upstreamRequired",
    );
    expect(playerInit.deps.needs).toEqual(["pregame", "world-init/schema-gen"]);

    // pre-turn band: rag-retriever + scene-cast, both scheduled.
    const retriever = requireSpec(specs, "npc-graph/rag-retriever");
    expect(retriever.stage).toBe("pre-turn");
    expect(retriever.declaredTrigger.type).toBe("scheduled");

    const sceneCast = requireSpec(specs, "scene-cast");
    expect(sceneCast.stage).toBe("pre-turn");
    expect(sceneCast.declaredTrigger.type).toBe("scheduled");

    const narrator = requireSpec(specs, "narrator");
    expect(narrator.stage).toBe("narrative");
    expect(requireSpec(specs, "chat-mode-narrator").stage).toBe("narrative");

    // post-turn `needs: [{capability}]` runtimes — single-declared now, so the
    // capability entry appears exactly once (no upstreamRequired alias).
    for (const id of [
      "guide",
      "codex",
      "npc-graph/extractor",
      "char-creator/character-tracker",
      "scene-prompts",
    ]) {
      const spec = requireSpec(specs, id);
      expect(spec.stage).toBe("post-turn");
      expect(spec.provenance.legacyFields).not.toContain("priority:stage");
      expect(spec.deps.needs).toEqual([{ capability: "narrative-engine" }]);
    }

    // branch-reply: post-turn with a typed `inputs.narrative` binding. No
    // `needs`; the binding is the ordering edge. `required: false` keeps
    // today's behavior — branch-reply runs even when the engine fails.
    const branchReply = requireSpec(specs, "branch-reply");
    expect(branchReply.stage).toBe("post-turn");
    expect(branchReply.deps.needs).toEqual([]);
    expect(branchReply.bindings).toEqual({
      narrative: {
        from: { capability: "narrative-engine", cardinality: "one" },
        select: "/narrativeOutput",
        required: false,
      },
    });
  });

  it("keeps event and manual runtimes stage-less", async () => {
    const manifests = await loadAllManifests();
    const specs = specById(manifests.map(normalizeRuntimeManifest));

    const resolver = requireSpec(specs, "scene-stage/resolver");
    expect(resolver.stage).toBeUndefined();
    expect(resolver.declaredTrigger.type).toBe("event");

    const backgroundGen = requireSpec(specs, "scene-stage/background-gen");
    expect(backgroundGen.stage).toBeUndefined();

    // Manual runtimes (real plugin-rpc actions): no stage, trigger untouched.
    for (const id of [
      "character-blueprint",
      "character-presence",
      "player-identity",
      "living-world-rules",
    ]) {
      const spec = requireSpec(specs, id);
      expect(spec.stage).toBeUndefined();
      expect(spec.declaredTrigger.type).toBe("manual");
    }
  });

  it("treats hook-only / UI-only plugins as contribution-only (never staged)", async () => {
    const manifests = await loadAllManifests();
    const specs = specById(manifests.map(normalizeRuntimeManifest));

    // director / story-guard / cost-gate are hook-only; memory is UI-only.
    // None declares a runtime shape, so normalize applies the default `auto`
    // trigger but derives NO stage — the UI-only idiom the scheduler drops.
    for (const id of ["director", "story-guard", "cost-gate", "memory"]) {
      const spec = requireSpec(specs, id);
      expect(spec.stage, `${id}: stage`).toBeUndefined();
      expect(spec.declaredTrigger.type, `${id}: trigger`).toBe("auto");
      expect(isSetupRuntime(manifestOf(manifests, id))).toBe(false);
    }
  });

  it("defaults new contract fields for every legacy manifest", async () => {
    const manifests = await loadAllManifests();
    for (const manifest of manifests) {
      const spec = normalizeRuntimeManifest(manifest);
      expect(spec.resultFormat).toBe(manifest.resultFormat ?? "legacy");
      expect(spec.suspensionSafe).toBe(false);
      expect(spec.bindings).toEqual(manifest.inputs ?? {});
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

function manifestOf(
  manifests: readonly RuntimeManifest[],
  id: string,
): RuntimeManifest {
  const m = manifests.find((x) => x.name === id);
  if (!m) throw new Error(`Missing manifest: ${id}`);
  return m;
}
