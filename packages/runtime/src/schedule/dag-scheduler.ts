/**
 * DAG scheduler — topological-level scheduling within a single stage.
 *
 * Priority scheduling treated every same-priority bucket as parallel and
 * everything else as strictly serial by number, which forced independent
 * branches to wait on each other (e.g. `codex` blocking on
 * `npc-graph/extractor` just because 620 < 650, even though they both only
 * depend on `narrator`).
 *
 * The DAG scheduler derives ordering edges from the normalized IR — turn-scoped
 * `deps.needs`, `deps.after`, typed `inputs` bindings — plus the legacy
 * `input.inject[].from` (kind `runtime`) injects. It performs a Kahn-style
 * topological sort and returns "levels": each level is a set of runtimes whose
 * dependencies have all completed and may therefore run concurrently. Within a
 * level, runtimes are ordered by name so traces stay readable and ties break
 * deterministically. A level runs via `executeParallel` (Promise.allSettled),
 * so the intra-level order is cosmetic — it does not drive the committed
 * narrative order, which follows real completion time (`createdAt`).
 *
 * `needs(scope: session)` entries are NOT execution edges: they gate against the
 * frozen persistent snapshot, evaluated separately from the intra-execution DAG.
 *
 * Dependencies that point outside `runtimes` are ignored (the scheduler only
 * knows about runtimes in scope). Cycles are reported via `error`; callers
 * disable the strongly-connected component (and its downstream) rather than
 * running it in an arbitrary order.
 */

import type { DependencyRef, RuntimeManifest } from "@covel/shared";
import { getRuntimeSpec } from "@covel/shared";
import type { ScheduledGroup } from "../types.js";

export interface DagScheduleResult {
  readonly groups: readonly ScheduledGroup[];
  readonly error?: string;
  /**
   * Runtimes the sort could not place — the strongly-connected component(s) it
   * hit plus everything downstream of them. Present only when `error` is set.
   * Callers disable exactly this set (`skipped: dependency-cycle`) and run the
   * acyclic `groups` normally, rather than falling back to a plain priority sort.
   */
  readonly cyclic?: readonly RuntimeManifest[];
}

/**
 * Resolve one `deps.needs` / `deps.after` entry into in-scope dependency names.
 * `session`-scoped `needs` entries are skipped (they gate against the frozen
 * snapshot, not the execution DAG); `after` entries carry no scope and always
 * order.
 */
function refToNames(
  ref: DependencyRef,
  kind: "needs" | "after",
  capabilityProviders: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  if (typeof ref === "string") return ref.length > 0 ? [ref] : [];
  if ("runtime" in ref) {
    if (kind === "needs" && ref.scope === "session") return [];
    return ref.runtime.length > 0 ? [ref.runtime] : [];
  }
  if (kind === "needs" && ref.scope === "session") return [];
  return capabilityProviders.get(ref.capability) ?? [];
}

/**
 * All ordering-dependency names a runtime declares, from the IR (`deps.needs`
 * turn-scoped + `deps.after` + `inputs` bindings) plus legacy runtime injects.
 * Not yet filtered to the in-scope set.
 */
function collectDependencies(
  manifest: RuntimeManifest,
  capabilityProviders: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const deps = new Set<string>();
  const spec = getRuntimeSpec(manifest);

  for (const decl of manifest.input?.inject ?? []) {
    if (decl.kind === "runtime" && decl.from.length > 0) deps.add(decl.from);
  }
  for (const need of spec.deps.needs) {
    for (const name of refToNames(need, "needs", capabilityProviders)) {
      deps.add(name);
    }
  }
  for (const after of spec.deps.after) {
    for (const name of refToNames(after, "after", capabilityProviders)) {
      deps.add(name);
    }
  }
  // Typed `inputs` bindings imply the same ordering edge: `required: true` →
  // needs(turn), `false` → after — both need the producer scheduled first.
  for (const binding of Object.values(spec.bindings)) {
    if ("runtime" in binding.from) {
      if (binding.from.runtime.length > 0) deps.add(binding.from.runtime);
    } else {
      for (const name of capabilityProviders.get(binding.from.capability) ??
        []) {
        deps.add(name);
      }
    }
  }
  return [...deps];
}

/**
 * Turn-scoped capability needs with `cardinality: one` are OR dependencies.
 * We normally wait for every provider so the runtime gate can observe all
 * outcomes, but a provider trapped in a separate cycle must not drag the
 * consumer into that cycle once another provider has completed.
 */
function collectOneProviderGroups(
  manifest: RuntimeManifest,
  capabilityProviders: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
  const groups: string[][] = [];
  for (const need of getRuntimeSpec(manifest).deps.needs) {
    if (
      typeof need === "string" ||
      "runtime" in need ||
      need.scope === "session" ||
      need.cardinality === "all"
    ) {
      continue;
    }
    const providers = capabilityProviders.get(need.capability) ?? [];
    if (providers.length > 0) groups.push([...providers]);
  }
  return groups;
}

function buildCapabilityProviders(
  runtimes: readonly RuntimeManifest[],
): Map<string, string[]> {
  const capabilityProviders = new Map<string, string[]>();
  for (const rt of runtimes) {
    for (const cap of rt.capabilities ?? []) {
      const list = capabilityProviders.get(cap) ?? [];
      list.push(rt.name);
      capabilityProviders.set(cap, list);
    }
  }
  return capabilityProviders;
}

/** Topologically sort `runtimes` into levels via a Kahn sort over declared edges. */
export function scheduleByDag(
  runtimes: readonly RuntimeManifest[],
): DagScheduleResult {
  if (runtimes.length === 0) return { groups: [] };

  const inScope = new Set(runtimes.map((r) => r.name));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const directDependencies = new Map<string, Set<string>>();
  const oneProviderGroups = new Map<string, readonly (readonly string[])[]>();
  const byName = new Map<string, RuntimeManifest>();
  const capabilityProviders = buildCapabilityProviders(runtimes);
  const completed = new Set<string>();

  for (const rt of runtimes) {
    byName.set(rt.name, rt);
    inDegree.set(rt.name, 0);
  }

  for (const rt of runtimes) {
    const deps = new Set(collectDependencies(rt, capabilityProviders));
    const inScopeDeps = new Set([...deps].filter((dep) => inScope.has(dep)));
    directDependencies.set(rt.name, inScopeDeps);
    oneProviderGroups.set(
      rt.name,
      collectOneProviderGroups(rt, capabilityProviders),
    );
    for (const dep of inScopeDeps) {
      // A self-edge is left in place: it makes the node unreachable in the Kahn
      // sort, so it (a plugin authoring mistake) surfaces as a cycle.
      inDegree.set(rt.name, (inDegree.get(rt.name) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(rt.name);
      dependents.set(dep, list);
    }
  }

  const levels: ScheduledGroup[] = [];
  // Ready = runtimes with inDegree 0, sorted by name (the deterministic
  // tie-break — a level runs in parallel, so this is trace order only).
  const pickReady = (): RuntimeManifest[] => {
    const ready: RuntimeManifest[] = [];
    for (const [name, deg] of inDegree) {
      if (deg === 0) {
        const rt = byName.get(name);
        if (rt) ready.push(rt);
      }
    }
    ready.sort((a, b) => a.name.localeCompare(b.name));
    return ready;
  };

  while (inDegree.size > 0) {
    let ready = pickReady();
    if (ready.length === 0) {
      // `needs({ capability, cardinality: "one" })` is an OR edge. Keep the
      // conservative all-provider barrier during normal scheduling, then relax
      // only blockers belonging to an OR group that already has a completed
      // provider. This prevents a cyclic alternative provider from classifying
      // an otherwise runnable consumer as cycle/downstream.
      for (const [name, deps] of directDependencies) {
        if (!inDegree.has(name)) continue;
        const remaining = [...deps].filter((dep) => inDegree.has(dep));
        if (remaining.length === 0) continue;
        const groups = oneProviderGroups.get(name) ?? [];
        const satisfiedGroups = groups.filter((group) =>
          group.some((provider) => completed.has(provider)),
        );
        if (satisfiedGroups.length === 0) continue;
        const relaxable = new Set(satisfiedGroups.flat());
        const hasUnsatisfiedGroup = groups.some(
          (group) =>
            group.some((provider) => inDegree.has(provider)) &&
            !group.some((provider) => completed.has(provider)),
        );
        if (
          !hasUnsatisfiedGroup &&
          remaining.every((dep) => relaxable.has(dep))
        ) {
          inDegree.set(name, 0);
        }
      }
      ready = pickReady();
    }
    if (ready.length === 0) {
      // Cycle — return the acyclic prefix plus the stuck nodes (the SCC and its
      // downstream) so the caller can disable exactly those and still run the
      // rest.
      const stuck = [...inDegree.keys()];
      return {
        groups: levels,
        error: `cycle detected among runtimes: ${stuck.join(", ")}`,
        cyclic: stuck.map((name) => byName.get(name)!).filter(Boolean),
      };
    }

    levels.push({ runtimes: ready });

    for (const rt of ready) {
      inDegree.delete(rt.name);
      completed.add(rt.name);
      for (const down of dependents.get(rt.name) ?? []) {
        // A cardinality-one consumer may have been released while an optional
        // provider was still stuck. Never resurrect an already-run node when
        // that provider becomes schedulable later.
        if (!inDegree.has(down)) continue;
        inDegree.set(down, (inDegree.get(down) ?? 0) - 1);
      }
    }
  }

  return { groups: levels };
}
