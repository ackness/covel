/**
 * Manifest → NormalizedRuntimeSpec normalization.
 *
 * This is the single place where the declared manifest surface folds into the
 * scheduling IR. Production scheduling consumes that IR: `stage` selects the
 * band and the DAG orders within it (see packages/runtime/src/schedule).
 *
 * `execution: background` and setup runtimes declared as `scheduled
 * interval: 1` fold here. Every manifest single-declares `stage` +
 * `needs`/`after` — there is no alternative spelling to reconcile.
 */

import type {
  DependencyRef,
  NormalizedRuntimeSpec,
  RuntimeBinding,
  RuntimeExportBinding,
  Stage,
  TriggerSpec,
} from "../types/runtime-scheduling.js";
import { STAGE_ORDER } from "../types/runtime-scheduling.js";
import type { RuntimeManifest } from "../types/plugin.js";

/**
 * Sort rank for listing / serialization consumers that order by
 * `(stage, name)` during the compat period, replacing the old
 * `legacyOrder ?? Infinity` sort. Stage-less runtimes (event / manual /
 * UI-only) rank last. Intra-stage order is broken by name at the call site.
 */
export function stageRank(stage: Stage | undefined): number {
  return stage === undefined ? STAGE_ORDER.length : STAGE_ORDER.indexOf(stage);
}

/**
 * Coarse `TurnMessageRecord.order` value. The field is written but never read
 * for sorting — every store sorts turn messages by `createdAt` — so this is a
 * stage ordinal only. The column is retained (dropping it needs a four-backend
 * migration for zero benefit). Stage-less runtimes write 99.
 */
export function stageMessageOrder(stage: Stage | undefined): number {
  return stage === undefined ? 99 : STAGE_ORDER.indexOf(stage);
}

function foldTrigger(
  manifest: RuntimeManifest,
  stage: Stage | undefined,
  derivedFrom: string[],
): TriggerSpec {
  const declared = manifest.trigger ?? { type: "auto" as const };
  if (manifest.trigger === undefined) derivedFrom.push("trigger:default-auto");

  // Setup runtimes are auto-only in the new model. The legacy idiom
  // `scheduled + interval: 1 + maxTriggerCount: 1` in the pre-game band is
  // behaviorally equivalent to `auto + maxTriggerCount: 1`, so fold it.
  if (stage === "setup" && declared.type === "scheduled") {
    derivedFrom.push("trigger:scheduled-as-auto");
    const { interval, startTurn, cooldownTurns, ...rest } = declared;
    void interval;
    void startTurn;
    void cooldownTurns;
    return { ...rest, type: "auto" };
  }
  return declared;
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
 * Stage resolution: `stage` is taken as declared. `event` / `manual` runtimes
 * declare none (fan-out orders them by name), and an `auto` / `scheduled`
 * runtime without one is not schedulable — the authoring schema rejects that
 * combination, and the loader warns for the compat schema.
 */
export function normalizeRuntimeManifest(
  manifest: RuntimeManifest,
): NormalizedRuntimeSpec {
  const derivedFrom: string[] = [];

  const stage: Stage | undefined = manifest.stage;

  const declaredTrigger = foldTrigger(manifest, stage, derivedFrom);

  if (manifest.execution === "background") derivedFrom.push("execution");

  const needs: readonly DependencyRef[] = manifest.needs ?? [];

  const bindings: Readonly<Record<string, RuntimeBinding>> =
    manifest.inputs ?? {};

  return {
    id: manifest.name,
    pluginId: manifest.pluginId,
    declaredTrigger,
    backgroundWhenDetached: manifest.execution === "background",
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
    provenance: { derivedFrom },
  };
}

/**
 * Memoized `normalizeRuntimeManifest`. A manifest object is immutable for the
 * lifetime of the registry that owns it, so the derived spec is cached per
 * manifest identity in a `WeakMap` — computed once, released with the manifest.
 * Consumers that only need the ordering surface (`stage`, `deps`) read through
 * this instead of re-deriving the whole spec each turn.
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

/**
 * Static detached-contract check (01 §4 rule 3): a spec whose declared entry is
 * ALWAYS detached (`event` / `manual` trigger + `backgroundWhenDetached`) may
 * not carry turn bindings — no activation of it could ever satisfy them, so the
 * loader rejects it deterministically. The activation-scoped twin (a stage spec
 * activated detached) is handled at run time, not here.
 */
export function hasIllegalDetachedContract(manifest: RuntimeManifest): boolean {
  const spec = getRuntimeSpec(manifest);
  const triggerType = spec.declaredTrigger.type;
  const alwaysDetached =
    (triggerType === "event" || triggerType === "manual") &&
    spec.backgroundWhenDetached;
  return alwaysDetached && Object.keys(spec.bindings).length > 0;
}
