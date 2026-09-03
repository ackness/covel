import {
  getRuntimeSpec,
  isTurnDetachedRuntime,
  type DependencyRef,
  type EffectResource,
  type Proposal,
  type RuntimeManifest,
} from "@covel/shared";

export interface TurnDetachmentDiagnostic {
  readonly runtimeId: string;
  readonly reason: string;
}

export interface TurnDetachmentPlan {
  readonly eligibleRuntimeIds: ReadonlySet<string>;
  readonly diagnostics: readonly TurnDetachmentDiagnostic[];
}

function declaredWriteAllows(
  manifest: RuntimeManifest,
  expected: EffectResource,
): boolean {
  const writes = getRuntimeSpec(manifest).effectsDecl?.writes ?? [];
  return writes.some(
    (write) =>
      write === expected ||
      (expected.startsWith("plugin-data:self:") &&
        write === "plugin-data:self:*") ||
      (expected.startsWith("ui:") && write === "ui:*"),
  );
}

/**
 * Runtime enforcement for the narrow detached effect contract. Static
 * manifest checks are not a security boundary: handlers can still return an
 * undeclared effect, so every buffered/normalized proposal is checked again
 * immediately before the transaction commits.
 */
export function createDetachedProposalGuard(
  manifest: RuntimeManifest,
): (proposal: Proposal) => string | undefined {
  return (proposal) => {
    if (proposal.type === "asset.generate") {
      return declaredWriteAllows(manifest, "assets:*") ||
        declaredWriteAllows(manifest, "media:*")
        ? undefined
        : "detached runtime emitted undeclared asset/media output";
    }
    if (proposal.type === "ui.render") {
      return declaredWriteAllows(manifest, "ui:*")
        ? undefined
        : "detached runtime emitted undeclared UI output";
    }
    if (proposal.type === "plugin.data") {
      const namespace = proposal.payload.namespace;
      if (namespace.startsWith("_")) {
        return "detached runtime cannot write framework-reserved plugin data";
      }
      return declaredWriteAllows(manifest, `plugin-data:self:${namespace}`)
        ? undefined
        : `detached runtime emitted undeclared plugin-data namespace ${namespace}`;
    }
    if (proposal.type === "plugin.data.batch") {
      for (const item of proposal.payload.items) {
        if (item.namespace.startsWith("_")) {
          return "detached runtime cannot write framework-reserved plugin data";
        }
        if (
          !declaredWriteAllows(manifest, `plugin-data:self:${item.namespace}`)
        ) {
          return `detached runtime emitted undeclared plugin-data namespace ${item.namespace}`;
        }
      }
      return undefined;
    }
    return `proposal type ${proposal.type} is not allowed for a detached stage runtime`;
  };
}

const SAFE_DETACHED_EXACT_EFFECTS = new Set<EffectResource>([
  "assets:*",
  "media:*",
]);

function isSafeDetachedEffect(effect: EffectResource): boolean {
  return (
    SAFE_DETACHED_EXACT_EFFECTS.has(effect) ||
    effect.startsWith("plugin-data:self:") ||
    effect.startsWith("ui:") ||
    effect.startsWith("http:")
  );
}

function isSafeDetachedRead(effect: EffectResource): boolean {
  // Mutable game/plugin data would be resolved at worker time instead of the
  // source turn's frozen snapshot. Immutable media/assets and provider reads
  // are safe; same-turn runtime inputs travel separately in upstreamResults.
  return (
    effect === "assets:*" || effect === "media:*" || effect.startsWith("http:")
  );
}

function dependencyMatches(
  dependency: DependencyRef,
  candidate: RuntimeManifest,
): boolean {
  if (typeof dependency === "string") return dependency === candidate.name;
  if ("runtime" in dependency) return dependency.runtime === candidate.name;
  return (candidate.capabilities ?? []).includes(dependency.capability);
}

function sourceMatches(
  source:
    | { readonly runtime: string }
    | { readonly capability: string; readonly cardinality?: "one" | "all" },
  candidate: RuntimeManifest,
): boolean {
  return "runtime" in source
    ? source.runtime === candidate.name
    : (candidate.capabilities ?? []).includes(source.capability);
}

function consumerDependsOn(
  consumer: RuntimeManifest,
  candidate: RuntimeManifest,
): boolean {
  const spec = getRuntimeSpec(consumer);
  if (
    [...spec.deps.after, ...spec.deps.needs].some((dependency) =>
      dependencyMatches(dependency, candidate),
    )
  ) {
    return true;
  }
  if (
    Object.values(spec.bindings).some((binding) =>
      sourceMatches(binding.from, candidate),
    )
  ) {
    return true;
  }
  return (consumer.input?.inject ?? []).some(
    (inject) => inject.kind === "runtime" && inject.from === candidate.name,
  );
}

function intrinsicIneligibility(manifest: RuntimeManifest): string | undefined {
  if (manifest.runtimeType !== "function") {
    return "the first detached-stage contract only permits function runtimes";
  }
  if (manifest.output?.recordAs) {
    return "recordAs exports cannot be published from a detached stage runtime";
  }
  if ((manifest.events?.length ?? 0) > 0 || manifest.advertiseEvents === true) {
    return "event emission is not supported by detached stage runtimes";
  }
  if (
    (manifest.input?.inject ?? []).some(
      (inject) => inject.kind === "plugin-data",
    )
  ) {
    return "live plugin-data prompt injection is not a frozen detached input";
  }

  const declaredEffects = getRuntimeSpec(manifest).effectsDecl;
  if (!declaredEffects) {
    return "detached stage runtimes must declare an explicit effects contract";
  }
  const unsafeRead = (declaredEffects.reads ?? []).find(
    (effect) => !isSafeDetachedRead(effect),
  );
  if (unsafeRead) {
    return `read effect ${unsafeRead} is not part of the frozen detached input`;
  }
  const unsafeEffect = (declaredEffects.writes ?? []).find(
    (effect) => !isSafeDetachedEffect(effect),
  );
  if (unsafeEffect) {
    return `effect ${unsafeEffect} is not isolated from foreground game state`;
  }
  return undefined;
}

/**
 * Compute the effective detached set for one scheduled turn.
 *
 * A manifest declaration is an opt-in request, not proof of safety. The
 * scheduler keeps an ineligible runtime in the foreground and emits a precise
 * diagnostic. This preserves the established turn barrier when a session's
 * active graph makes a previously-safe leaf gain a consumer.
 */
export function planTurnDetachment(
  scheduledRuntimes: readonly RuntimeManifest[],
): TurnDetachmentPlan {
  const eligibleRuntimeIds = new Set<string>();
  const diagnostics: TurnDetachmentDiagnostic[] = [];

  for (const candidate of scheduledRuntimes) {
    if (!isTurnDetachedRuntime(getRuntimeSpec(candidate))) continue;

    const intrinsic = intrinsicIneligibility(candidate);
    if (intrinsic) {
      diagnostics.push({ runtimeId: candidate.name, reason: intrinsic });
      continue;
    }

    const consumer = scheduledRuntimes.find(
      (runtime) =>
        runtime.name !== candidate.name &&
        consumerDependsOn(runtime, candidate),
    );
    if (consumer) {
      diagnostics.push({
        runtimeId: candidate.name,
        reason: `foreground runtime ${consumer.name} depends on its result`,
      });
      continue;
    }

    eligibleRuntimeIds.add(candidate.name);
  }

  return { eligibleRuntimeIds, diagnostics };
}
