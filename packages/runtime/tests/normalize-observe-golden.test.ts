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
import { scheduleByDag } from "../src/schedule/dag-scheduler.js";

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

/** Flatten a DAG plan into level-groups of runtime names. */
function levelsOf(runtimes: readonly RuntimeManifest[]): readonly string[][] {
  const plan = scheduleByDag(runtimes);
  return plan.groups.map((g) => g.runtimes.map((r) => r.name));
}

describe("normalize golden (bundled plugin set)", () => {
  it("derives a stage exactly for band-schedulable runtimes", async () => {
    const manifests = await loadAllManifests();
    for (const manifest of manifests) {
      const spec = normalizeRuntimeManifest(manifest);
      // Stage-less declarations are the UI-only idiom (never scheduled); only
      // auto/scheduled runtimes with a stage (explicit, or priority-derived
      // for legacy third-party manifests) enter the pipeline.
      const expectStage =
        manifest.stage !== undefined ||
        (manifest.priority !== undefined && isStageSourceManifest(manifest));
      expect(
        spec.stage !== undefined,
        `${manifest.name}: stage presence mismatch`,
      ).toBe(expectStage);
    }
  });

  it("orders the setup stage by declared edges (pregame → schema-gen → player-init)", async () => {
    const manifests = await loadAllManifests();
    const setup = manifests.filter(isSetupRuntime);
    // Declared edges carry the whole order now: schema-gen declares
    // `after: [pregame]` and player-init's turn-scoped `needs` orders it
    // after both. Same serial order the legacy priority chain produced.
    // `scene-stage/seed` declares no edge — it only reads its own plugin_data,
    // so it joins the first level in parallel (name breaks the tie).
    expect(levelsOf(setup)).toEqual([
      ["pregame", "scene-stage/seed"],
      ["world-init/schema-gen"],
      ["char-creator/player-init"],
    ]);
  });

  it("runs the shared WorldIR extractor before structured post-turn consumers", async () => {
    const manifests = await loadAllManifests();
    const specs = specById(manifests.map(normalizeRuntimeManifest));
    const postTurn = manifests.filter(
      (m) => specs.get(m.name)?.stage === "post-turn",
    );
    // Raw narrative consumers stay in the first level. Structured state
    // consumers depend on the shared world-ir provider and form a second
    // parallel level, so one extraction is reused instead of each plugin
    // independently parsing the same story text.
    const levels = levelsOf(postTurn);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toEqual([
      "branch-reply",
      "char-creator/character-tracker",
      "guide",
      "mimo-tts/auto-narrate",
      "scene-prompts",
      "world-ir",
    ]);
    expect(levels[1]).toEqual([
      "affinity",
      "codex",
      "core-quest",
      "inventory",
      "npc-graph/extractor",
    ]);
  });

  it("maps the documented core chain onto the single-declaration surface", async () => {
    const manifests = await loadAllManifests();
    const specs = specById(manifests.map(normalizeRuntimeManifest));

    // pregame / schema-gen are single-declared now: explicit `stage: setup` +
    // `trigger: auto` (maxTriggerCount = retry budget); schema-gen carries the
    // authored `after: [pregame]` ordering edge. No legacy provenance left in
    // any bundled manifest.
    const pregame = requireSpec(specs, "pregame");
    expect(pregame.stage).toBe("setup");
    expect(pregame.declaredTrigger.type).toBe("auto");
    expect(pregame.declaredTrigger.interval).toBeUndefined();
    expect(pregame.declaredTrigger.maxTriggerCount).toBe(1);
    expect(pregame.provenance.derivedFrom).toEqual([]);

    const schemaGen = requireSpec(specs, "world-init/schema-gen");
    expect(schemaGen.stage).toBe("setup");
    expect(schemaGen.declaredTrigger.type).toBe("auto");
    expect(schemaGen.deps.after).toEqual(["pregame"]);
    expect(schemaGen.provenance.derivedFrom).toEqual([]);

    // player-init: explicit `stage: setup` plus turn-scoped `needs`, which are
    // the DAG edge and the same-turn gate.
    const playerInit = requireSpec(specs, "char-creator/player-init");
    expect(playerInit.stage).toBe("setup");
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

    // Raw-text post-turn consumers still bind directly to the narrative
    // engine. They remain independent of the structured extraction branch.
    for (const id of [
      "guide",
      "char-creator/character-tracker",
      "mimo-tts/auto-narrate",
    ]) {
      const spec = requireSpec(specs, id);
      expect(spec.stage).toBe("post-turn");
      expect(spec.deps.needs).toEqual([{ capability: "narrative-engine" }]);
    }

    const worldIr = requireSpec(specs, "world-ir");
    expect(worldIr.stage).toBe("post-turn");
    expect(manifestOf(manifests, "world-ir").capabilities).toContain(
      "world-ir-provider",
    );
    expect(worldIr.bindings.narrative).toMatchObject({
      from: { capability: "narrative-engine", cardinality: "one" },
      select: "/narrativeOutput",
      required: true,
    });

    // Structured consumers use only the typed WorldIR slot. The binding is
    // both the DAG edge and the same-turn failure gate.
    for (const id of [
      "affinity",
      "codex",
      "core-quest",
      "inventory",
      "npc-graph/extractor",
    ]) {
      const spec = requireSpec(specs, id);
      expect(spec.stage).toBe("post-turn");
      expect(spec.deps.needs).toEqual([]);
      expect(spec.bindings.worldIR).toMatchObject({
        from: { capability: "world-ir-provider", cardinality: "one" },
        accepts: "covel://world/ir/v1",
        required: true,
      });
    }

    // scene-prompts uses a required typed binding instead of duplicating the
    // same dependency in `needs`; the binding supplies both its DAG edge and
    // same-turn gate.
    const scenePrompts = requireSpec(specs, "scene-prompts");
    expect(scenePrompts.stage).toBe("post-turn");
    expect(scenePrompts.deps.needs).toEqual([]);
    expect(scenePrompts.bindings.narrative).toMatchObject({
      from: { capability: "narrative-engine", cardinality: "one" },
      select: "/narrativeOutput",
      required: true,
    });

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

  it("defaults normalized contract fields for every manifest", async () => {
    const manifests = await loadAllManifests();
    for (const manifest of manifests) {
      const spec = normalizeRuntimeManifest(manifest);
      expect(spec.bindings).toEqual(manifest.inputs ?? {});
      expect(spec.exportBindings).toEqual({});
      expect(spec.httpPermissions).toEqual([]);
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
