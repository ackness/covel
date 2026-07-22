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

    // W5a double-declaration is now live: migrated runtimes carry an explicit
    // `stage` (+ `needs` / `inputs`) while `priority` / `upstreamRequired`
    // stay as compat aliases. pregame / schema-gen are the exception — the
    // loader forbids `stage: setup` on a `scheduled`/`interval` trigger, so
    // these two keep the legacy setup idiom and let normalize DERIVE the stage
    // (hence `priority:stage` is still in their provenance). The idiom
    // `scheduled + interval: 1 + maxTriggerCount: 1` folds to auto with the
    // attempt budget preserved.
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

    // player-init IS double-declared (its trigger is already `auto`, so an
    // explicit `stage: setup` is legal). Explicit stage means normalize does
    // NOT re-derive it — `priority:stage` is absent from provenance. During
    // the compat period both `needs` (new, scoped) and the `upstreamRequired`
    // alias (old, string) are present, so deps.needs concatenates them; the
    // alias entries collapse in Step 6 when `upstreamRequired` is removed.
    const playerInit = requireSpec(specs, "char-creator/player-init");
    expect(playerInit.stage).toBe("setup");
    expect(playerInit.provenance.legacyFields).not.toContain("priority:stage");
    expect(playerInit.provenance.legacyFields).toContain("upstreamRequired");
    expect(playerInit.deps.needs).toEqual([
      { runtime: "pregame", scope: "session" },
      { runtime: "world-init/schema-gen", scope: "session" },
      "pregame",
      "world-init/schema-gen",
    ]);

    // pre-turn band: rag-retriever + scene-cast, both scheduled. Explicit
    // stage → no `priority:stage`; the scheduled trigger is left untouched.
    const retriever = requireSpec(specs, "npc-graph/rag-retriever");
    expect(retriever.stage).toBe("pre-turn");
    expect(retriever.declaredTrigger.type).toBe("scheduled");
    expect(retriever.provenance.legacyFields).not.toContain("priority:stage");

    const sceneCast = requireSpec(specs, "scene-cast");
    expect(sceneCast.stage).toBe("pre-turn");
    expect(sceneCast.declaredTrigger.type).toBe("scheduled");
    expect(sceneCast.legacyOrder).toBe(450);
    expect(sceneCast.provenance.legacyFields).not.toContain("priority:stage");

    const narrator = requireSpec(specs, "narrator");
    expect(narrator.stage).toBe("narrative");
    expect(narrator.provenance.legacyFields).not.toContain("priority:stage");
    expect(requireSpec(specs, "chat-mode-narrator").stage).toBe("narrative");

    // post-turn `needs: [{capability}]` runtimes. Same compat concat as
    // player-init: explicit `needs` + `upstreamRequired` alias are both
    // present, so deps.needs carries the capability entry twice until Step 6.
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
      expect(spec.deps.needs).toEqual([
        { capability: "narrative-engine" },
        { capability: "narrative-engine" },
      ]);
    }

    // branch-reply: post-turn with a typed `inputs.narrative` binding (the
    // implicit narrator dependency promoted, 04 §1). No `needs` /
    // `upstreamRequired`, so it stays ungated (deps.needs empty); the binding
    // surfaces as `spec.bindings`. `required: false` keeps today's behavior —
    // branch-reply runs even when the narrative engine fails.
    const branchReply = requireSpec(specs, "branch-reply");
    expect(branchReply.stage).toBe("post-turn");
    expect(branchReply.provenance.legacyFields).not.toContain("priority:stage");
    expect(branchReply.deps.needs).toEqual([]);
    expect(branchReply.bindings).toEqual({
      narrative: {
        from: { capability: "narrative-engine", cardinality: "one" },
        select: "/narrativeOutput",
        required: false,
      },
    });
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

    // Manual runtimes (real plugin-rpc actions) are never double-declared: no
    // stage, no legacyOrder, trigger untouched. The former hook-only / UI-only
    // dummies (director / story-guard / cost-gate / memory) dropped their
    // `trigger: manual` shell — they are asserted separately below.
    for (const id of [
      "character-blueprint",
      "character-presence",
      "player-identity",
      "living-world-rules",
    ]) {
      const spec = requireSpec(specs, id);
      expect(spec.stage).toBeUndefined();
      expect(spec.declaredTrigger.type).toBe("manual");
      expect(spec.legacyOrder).toBeUndefined();
    }
  });

  it("treats hook-only / UI-only plugins as contribution-only (never scheduled)", async () => {
    const manifests = await loadAllManifests();
    const specs = specById(manifests.map(normalizeRuntimeManifest));

    // director / story-guard / cost-gate are hook-only; memory is UI-only.
    // None declares a runtime shape any more (no runtimeType / handler /
    // trigger / priority), so normalize applies the default `auto` trigger but
    // derives NO stage and NO legacyOrder — the UI-only idiom the scheduler
    // drops (priority === undefined ⇒ never scheduled).
    const contributionOnly = ["director", "story-guard", "cost-gate", "memory"];
    for (const id of contributionOnly) {
      const spec = requireSpec(specs, id);
      expect(spec.stage, `${id}: stage`).toBeUndefined();
      expect(spec.legacyOrder, `${id}: legacyOrder`).toBeUndefined();
      expect(spec.declaredTrigger.type, `${id}: trigger`).toBe("auto");
    }

    // Priority-band scheduling excludes them in both the pre-game and main-loop
    // bands — the invariant that keeps a handler-less contribution plugin off
    // the LLM pipeline.
    const scheduledIds = new Set(
      [0, 1].flatMap((turn) =>
        scheduleByPriority(manifests, turn).flatMap((group) =>
          group.runtimes.map((runtime) => runtime.name),
        ),
      ),
    );
    for (const id of contributionOnly) {
      expect(scheduledIds.has(id), `${id}: must not be scheduled`).toBe(false);
    }
  });

  it("defaults new contract fields for every legacy manifest", async () => {
    const manifests = await loadAllManifests();
    for (const manifest of manifests) {
      const spec = normalizeRuntimeManifest(manifest);
      expect(spec.resultFormat).toBe("legacy");
      expect(spec.suspensionSafe).toBe(false);
      // `bindings` mirrors `manifest.inputs`; only branch-reply is
      // double-declared with an `inputs` binding in the compat period, every
      // other bundled manifest still defaults to none.
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
