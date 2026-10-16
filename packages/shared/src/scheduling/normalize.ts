/**
 * Manifest → NormalizedRuntimeSpec normalization.
 *
 * This is the single place where the declared manifest surface folds into the
 * scheduling IR. Production scheduling consumes that IR: `stage` selects the
 * band and the DAG orders within it (see packages/runtime/src/schedule).
 *
 * `execution: background` folds here. Every manifest single-declares `stage` +
 * `needs`/`after`, and a runtime without a trigger is `auto`; there is no
 * alternative spelling to reconcile.
 */

import type {
  DependencyRef,
  NormalizedRuntimeSpec,
  RuntimeBinding,
  RuntimeExportBinding,
  Stage,
  TriggerSpec,
  TurnCompletionPolicy,
} from "../types/runtime-scheduling.js";
import { STAGE_ORDER } from "../types/runtime-scheduling.js";
import type { RuntimeManifest } from "../types/plugin.js";

/**
 * Sort rank for listing / serialization consumers that order by
 * `(stage, name)`. Stage-less runtimes (event / manual /
 * UI-only) rank last. Intra-stage order is broken by name at the call site.
 */
export function stageRank(stage: Stage | undefined): number {
  return stage === undefined ? STAGE_ORDER.length : STAGE_ORDER.indexOf(stage);
}

/**
 * Stage ordinal used to order messages sharing a timestamp. Stage-less
 * runtimes write 99; stores sort by `(createdAt, order, id)`.
 */
export function stageMessageOrder(stage: Stage | undefined): number {
  return stage === undefined ? 99 : STAGE_ORDER.indexOf(stage);
}

function declaredTrigger(manifest: RuntimeManifest): TriggerSpec {
  return manifest.trigger ?? { type: "auto" };
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

function normalizeTurnCompletionPolicy(
  manifest: RuntimeManifest,
): TurnCompletionPolicy {
  const declared = manifest.turnCompletion;
  return {
    mode: declared?.mode ?? "await",
    ...(declared?.settle ? { settle: true } : {}),
    ...(declared?.maxSettleWaitMs !== undefined
      ? { maxSettleWaitMs: declared.maxSettleWaitMs }
      : {}),
    ...(declared?.maxQueueMs !== undefined
      ? { maxQueueMs: declared.maxQueueMs }
      : {}),
    ...(declared?.maxExecutionMs !== undefined
      ? { maxExecutionMs: declared.maxExecutionMs }
      : {}),
  };
}

/**
 * Normalize one runtime manifest into the loader-level IR node.
 *
 * Stage resolution: `stage` is taken as declared. `event` / `manual` runtimes
 * declare none (fan-out orders them by name). An authored `auto` runtime
 * without one never reaches the IR: the loader leaves it out of its package
 * and reports why.
 */
export function normalizeRuntimeManifest(
  manifest: RuntimeManifest,
): NormalizedRuntimeSpec {
  const stage: Stage | undefined = manifest.stage;

  const trigger = declaredTrigger(manifest);

  const turnCompletionPolicy = normalizeTurnCompletionPolicy(manifest);

  const needs: readonly DependencyRef[] = manifest.needs ?? [];

  const bindings: Readonly<Record<string, RuntimeBinding>> =
    manifest.inputs ?? {};

  return {
    id: manifest.name,
    pluginId: manifest.pluginId,
    declaredTrigger: trigger,
    backgroundWhenDetached: manifest.execution === "background",
    turnCompletionPolicy,
    ...(stage !== undefined ? { stage } : {}),
    deps: {
      after: manifest.after ?? [],
      needs,
    },
    bindings,
    exportBindings: collectExportBindings(manifest),
    ...(manifest.effects !== undefined
      ? { effectsDecl: manifest.effects }
      : {}),
  };
}

/** Whether a normalized staged runtime may run beyond the foreground barrier. */
export function isTurnDetachedRuntime(spec: NormalizedRuntimeSpec): boolean {
  return spec.turnCompletionPolicy.mode === "detached";
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

/** Public discovery view of the normalized turn-completion policy. */
export type EffectiveTurnCompletion =
  | { readonly mode: "await" }
  | {
      readonly mode: "detached";
      readonly settle?: boolean;
      readonly maxSettleWaitMs?: number;
      readonly maxQueueMs?: number;
      readonly maxExecutionMs?: number;
    };

/**
 * Project one effective policy for API/discovery consumers. Keeping this next
 * to normalization makes future policy fields a single shared change instead
 * of a set of subtly divergent route-local serializers.
 */
export function effectiveTurnCompletion(
  manifest: RuntimeManifest,
): EffectiveTurnCompletion {
  const policy = getRuntimeSpec(manifest).turnCompletionPolicy;
  return policy.mode === "detached"
    ? {
        mode: "detached",
        ...(policy.settle ? { settle: true } : {}),
        ...(policy.maxSettleWaitMs !== undefined
          ? { maxSettleWaitMs: policy.maxSettleWaitMs }
          : {}),
        ...(policy.maxQueueMs !== undefined
          ? { maxQueueMs: policy.maxQueueMs }
          : {}),
        ...(policy.maxExecutionMs !== undefined
          ? { maxExecutionMs: policy.maxExecutionMs }
          : {}),
      }
    : { mode: "await" };
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
