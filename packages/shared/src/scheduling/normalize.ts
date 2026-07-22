/**
 * Manifest → NormalizedRuntimeSpec normalization (observe-only for now).
 *
 * This is the single place where legacy manifest surface (numeric
 * `priority` bands, `upstreamRequired`, `execution: background`, setup
 * runtimes declared as `scheduled interval: 1`) folds into the scheduling
 * IR. Production scheduling does not consume the IR yet — golden
 * characterization tests pin the mapping against current scheduler
 * behavior until the switch-over.
 */

import type {
  DependencyRef,
  NormalizedRuntimeSpec,
  RuntimeBinding,
  RuntimeExportBinding,
  Stage,
  TriggerSpec,
} from "../types/runtime-scheduling.js";
import type { RuntimeManifest } from "../types/plugin.js";

/**
 * Numeric priority band → named stage. Mirrors the priority bands the
 * kernel enforces today: pre-game 0–99, pre-narrator 100–499, narrator
 * 500, post-narrator 501–999, audit 1000.
 */
export function stageForPriority(priority: number): Stage {
  if (priority <= 99) return "setup";
  if (priority <= 499) return "pre-turn";
  if (priority === 500) return "narrative";
  if (priority <= 999) return "post-turn";
  return "audit";
}

function foldTrigger(
  manifest: RuntimeManifest,
  stage: Stage | undefined,
  legacyFields: string[],
): TriggerSpec {
  const declared = manifest.trigger ?? { type: "auto" as const };
  if (manifest.trigger === undefined) legacyFields.push("trigger:default-auto");

  // Setup runtimes are auto-only in the new model. The legacy idiom
  // `scheduled + interval: 1 + maxTriggerCount: 1` in the pre-game band is
  // behaviorally equivalent to `auto + maxTriggerCount: 1`, so fold it.
  if (stage === "setup" && declared.type === "scheduled") {
    legacyFields.push("trigger:scheduled-as-auto");
    const { interval, startTurn, cooldownTurns, ...rest } = declared;
    void interval;
    void startTurn;
    void cooldownTurns;
    return { ...rest, type: "auto" };
  }
  return declared;
}

function aliasUpstreamRequired(
  manifest: RuntimeManifest,
  legacyFields: string[],
): readonly DependencyRef[] {
  if (!manifest.upstreamRequired?.length) return [];
  legacyFields.push("upstreamRequired");
  // Legacy semantics are "same-turn success required", which is exactly
  // `needs(scope: turn)` — the default scope, so entries map through
  // unchanged in shape.
  return manifest.upstreamRequired.map((entry) =>
    typeof entry === "string" ? entry : { capability: entry.capability },
  );
}

function collectExportBindings(
  manifest: RuntimeManifest,
): Readonly<Record<string, RuntimeExportBinding>> {
  const result: Record<string, RuntimeExportBinding> = {};
  for (const inject of manifest.input?.inject ?? []) {
    if (inject.kind === "runtime-export") {
      result[inject.name] = inject;
    }
  }
  return result;
}

/**
 * Normalize one runtime manifest into the loader-level IR node.
 *
 * Stage resolution: an explicit `stage` declaration wins (double-declared
 * manifests keep `priority` only as `legacyOrder`). Otherwise the stage is
 * derived from the priority band — but only for `auto` / `scheduled`
 * runtimes; `event` / `manual` runtimes never get a stage (their priority
 * is kept solely as `legacyOrder` for fan-out ordering), and a declared
 * `auto` / `scheduled` runtime without a priority is the legacy "UI-only"
 * idiom: no stage, not schedulable.
 */
export function normalizeRuntimeManifest(
  manifest: RuntimeManifest,
): NormalizedRuntimeSpec {
  const legacyFields: string[] = [];

  const declaredType = manifest.trigger?.type ?? "auto";
  const isReserved =
    declaredType === "conditional" || declaredType === "error-retry";
  const isStageSource = declaredType === "auto" || declaredType === "scheduled";

  let stage: Stage | undefined = manifest.stage;
  if (
    stage === undefined &&
    isStageSource &&
    !isReserved &&
    manifest.priority !== undefined
  ) {
    stage = stageForPriority(manifest.priority);
    legacyFields.push("priority:stage");
  }

  const declaredTrigger = isReserved
    ? (manifest.trigger ?? { type: declaredType })
    : foldTrigger(manifest, stage, legacyFields);

  if (manifest.priority !== undefined) legacyFields.push("priority");
  if (manifest.execution === "background") legacyFields.push("execution");

  const needs: DependencyRef[] = [
    ...(manifest.needs ?? []),
    ...aliasUpstreamRequired(manifest, legacyFields),
  ];

  const bindings: Readonly<Record<string, RuntimeBinding>> =
    manifest.inputs ?? {};

  return {
    id: manifest.name,
    pluginId: manifest.pluginId,
    declaredTrigger,
    ...(isReserved ? { disabledReason: "reserved-trigger" as const } : {}),
    backgroundWhenDetached: manifest.execution === "background",
    suspensionSafe: manifest.suspensionSafe ?? false,
    resultFormat: manifest.resultFormat ?? "legacy",
    ...(stage !== undefined ? { stage } : {}),
    deps: {
      after: manifest.after ?? [],
      needs,
    },
    bindings,
    exportBindings: collectExportBindings(manifest),
    schemas: {
      ...(manifest.input?.schema !== undefined
        ? { activation: manifest.input.schema }
        : {}),
      ...(manifest.output?.schema !== undefined
        ? { output: manifest.output.schema }
        : {}),
    },
    ...(manifest.output?.recordAs !== undefined
      ? { outputRecordAs: manifest.output.recordAs }
      : {}),
    ...(manifest.effects !== undefined
      ? { effectsDecl: manifest.effects }
      : {}),
    httpPermissions: manifest.permissions?.http ?? [],
    legacyJobViews: manifest.jobStatus?.legacyViews ?? [],
    ...(manifest.priority !== undefined
      ? { legacyOrder: manifest.priority }
      : {}),
    provenance: { legacyFields },
  };
}

/**
 * Memoized `normalizeRuntimeManifest`. A manifest object is immutable for the
 * lifetime of the registry that owns it, so the derived spec is cached per
 * manifest identity in a `WeakMap` — computed once, released with the manifest.
 * Compat-period consumers that only need the ordering surface (`legacyOrder`,
 * `stage`) read through this instead of re-deriving the whole spec each turn.
 */
const specCache = new WeakMap<RuntimeManifest, NormalizedRuntimeSpec>();

export function getRuntimeSpec(
  manifest: RuntimeManifest,
): NormalizedRuntimeSpec {
  const cached = specCache.get(manifest);
  if (cached !== undefined) return cached;
  const spec = normalizeRuntimeManifest(manifest);
  specCache.set(manifest, spec);
  return spec;
}
