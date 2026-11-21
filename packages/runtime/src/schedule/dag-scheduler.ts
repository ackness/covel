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
 * `deps.needs`, `deps.after` and typed `inputs` bindings. It performs a Kahn-style
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

import { compareText } from "@covel/shared";
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
 * turn-scoped + `deps.after` + `inputs` bindings).
 * Not yet filtered to the in-scope set.
 */
function collectDependencies(
  manifest: RuntimeManifest,
  capabilityProviders: ReadonlyMap<string, readonly string[]>,
): {
  readonly all: ReadonlySet<string>;
  readonly hard: ReadonlySet<string>;
  readonly pureOrHard: ReadonlySet<string>;
} {
  const deps = new Set<string>();
  const hard = new Set<string>();
  // Edges that must not be broken by pure `needs(cardinality: one)` OR-cycle
  // relaxation when the consumer itself sits in a mutual ordering cycle with a
  // provider (e.g. explicit `after` or `inputs` binding alongside `needs`).
  const pureOrHard = new Set<string>();
  const spec = getRuntimeSpec(manifest);

  for (const need of spec.deps.needs) {
    for (const name of refToNames(need, "needs", capabilityProviders)) {
      deps.add(name);
      if (
        typeof need === "string" ||
        "runtime" in need ||
        need.cardinality === "all"
      ) {
        hard.add(name);
        pureOrHard.add(name);
      }
    }
  }
  for (const after of spec.deps.after) {
    for (const name of refToNames(after, "after", capabilityProviders)) {
      deps.add(name);
      pureOrHard.add(name);
    }
  }
  // Typed `inputs` bindings imply the same ordering edge: `required: true` →
  // needs(turn), `false` → after — both need the producer scheduled first,
  // while only required runtime or `cardinality: "all"` capability bindings are
  // hard blockers if an upstream sits in an independent dead cycle.
  for (const binding of Object.values(spec.bindings)) {
    const required = binding.required !== false;
    if ("runtime" in binding.from) {
      if (binding.from.runtime.length > 0) {
        deps.add(binding.from.runtime);
        pureOrHard.add(binding.from.runtime);
        if (required) hard.add(binding.from.runtime);
      }
    } else {
      const hardBinding = required && binding.from.cardinality === "all";
      for (const name of capabilityProviders.get(binding.from.capability) ??
        []) {
        deps.add(name);
        pureOrHard.add(name);
        if (hardBinding) hard.add(name);
      }
    }
  }
  return { all: deps, hard, pureOrHard };
}

/**
 * Turn-scoped capability needs and required capability input bindings with
 * `cardinality: one` (default) are OR dependencies for cycle isolation.
 * We normally wait for every provider so gates can observe all outcomes, but a
 * provider trapped in a separate cycle must not drag the consumer into that
 * cycle once another provider has completed.
 */
function collectOneProviderGroups(
  manifest: RuntimeManifest,
  capabilityProviders: ReadonlyMap<string, readonly string[]>,
): {
  readonly pureNeeds: readonly (readonly string[])[];
  readonly all: readonly (readonly string[])[];
} {
  const spec = getRuntimeSpec(manifest);
  const pureNeeds: string[][] = [];
  const all: string[][] = [];
  for (const need of spec.deps.needs) {
    if (
      typeof need === "string" ||
      "runtime" in need ||
      need.scope === "session" ||
      need.cardinality === "all"
    ) {
      continue;
    }
    const providers = capabilityProviders.get(need.capability) ?? [];
    if (providers.length > 0) {
      pureNeeds.push([...providers]);
      all.push([...providers]);
    }
  }
  for (const binding of Object.values(spec.bindings)) {
    if (
      binding.required === false ||
      "runtime" in binding.from ||
      binding.from.cardinality === "all"
    ) {
      continue;
    }
    const providers = capabilityProviders.get(binding.from.capability) ?? [];
    if (providers.length > 0) all.push([...providers]);
  }
  return { pureNeeds, all };
}

/**
 * Return every node in `nodes` that lies on a directed cycle (a strongly
 * connected component of size > 1, or a self-loop) within the induced subgraph.
 */
function findCycleNodes(
  nodes: ReadonlySet<string>,
  directDependencies: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const inCycle = new Set<string>();
  let nextIndex = 0;

  const visit = (v: string): void => {
    const vIndex = nextIndex++;
    indexOf.set(v, vIndex);
    lowlink.set(v, vIndex);
    stack.push(v);
    onStack.add(v);

    for (const w of directDependencies.get(v) ?? []) {
      if (!nodes.has(w)) continue;
      if (!indexOf.has(w)) {
        visit(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indexOf.get(w)!));
      }
    }

    if (lowlink.get(v) === vIndex) {
      const component: string[] = [];
      while (stack.length > 0) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      if (
        component.length > 1 ||
        (component.length === 1 && directDependencies.get(v)?.has(v))
      ) {
        for (const member of component) inCycle.add(member);
      }
    }
  };

  for (const node of nodes) {
    if (!indexOf.has(node)) visit(node);
  }
  return inCycle;
}

function buildCapabilityProviders(
  runtimes: readonly RuntimeManifest[],
): Map<string, string[]> {
  const capabilityProviders = new Map<string, string[]>();
  for (const rt of runtimes) {
    for (const cap of rt.outputContract ? [rt.outputContract] : []) {
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
  satisfiedRuntimes: readonly RuntimeManifest[] = [],
): DagScheduleResult {
  if (runtimes.length === 0) return { groups: [] };

  const inScope = new Set(runtimes.map((r) => r.name));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const directDependencies = new Map<string, Set<string>>();
  const hardDependencies = new Map<string, ReadonlySet<string>>();
  const pureOrHardDependencies = new Map<string, ReadonlySet<string>>();
  const pureNeedProviderGroups = new Map<
    string,
    readonly (readonly string[])[]
  >();
  const oneProviderGroups = new Map<string, readonly (readonly string[])[]>();
  const byName = new Map<string, RuntimeManifest>();
  // Only external outcomes can satisfy an OR edge before this batch runs.
  // They provide evidence, never additional nodes to execute.
  const external = satisfiedRuntimes.filter((rt) => !inScope.has(rt.name));
  const capabilityProviders = buildCapabilityProviders([
    ...runtimes,
    ...external,
  ]);
  const completed = new Set(external.map((rt) => rt.name));

  for (const rt of runtimes) {
    byName.set(rt.name, rt);
    inDegree.set(rt.name, 0);
  }

  for (const rt of runtimes) {
    const deps = collectDependencies(rt, capabilityProviders);
    const inScopeDeps = new Set(
      [...deps.all].filter((dep) => inScope.has(dep)),
    );
    hardDependencies.set(rt.name, deps.hard);
    pureOrHardDependencies.set(rt.name, deps.pureOrHard);
    directDependencies.set(rt.name, inScopeDeps);
    const groups = collectOneProviderGroups(rt, capabilityProviders);
    pureNeedProviderGroups.set(rt.name, groups.pureNeeds);
    oneProviderGroups.set(rt.name, groups.all);
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
    ready.sort((a, b) => compareText(a.name, b.name));
    return ready;
  };

  const hasUnsatisfiedOneGroup = (
    groups: readonly (readonly string[])[],
  ): boolean =>
    groups.some(
      (group) =>
        group.some((provider) => inDegree.has(provider)) &&
        !group.some((provider) => completed.has(provider)),
    );

  while (inDegree.size > 0) {
    let ready = pickReady();
    if (ready.length === 0) {
      // Phase 1: `needs({ capability, cardinality: "one" })` is an OR edge.
      // Keep the conservative all-provider barrier during normal scheduling,
      // then relax only pure OR blockers whose group already has a completed
      // provider, while preserving any independent ordering constraints.
      for (const [name, deps] of directDependencies) {
        if (!inDegree.has(name)) continue;
        const remaining = [...deps].filter((dep) => inDegree.has(dep));
        if (remaining.length === 0) continue;
        const groups = pureNeedProviderGroups.get(name) ?? [];
        const satisfiedGroups = groups.filter((group) =>
          group.some((provider) => completed.has(provider)),
        );
        if (satisfiedGroups.length === 0) continue;
        const relaxable = new Set(satisfiedGroups.flat());
        if (
          !hasUnsatisfiedOneGroup(groups) &&
          remaining.every(
            (dep) =>
              relaxable.has(dep) && !pureOrHardDependencies.get(name)?.has(dep),
          )
        ) {
          inDegree.set(name, 0);
        }
      }
      ready = pickReady();
    }
    if (ready.length === 0) {
      // Phase 2: isolate permanently cyclic nodes (nontrivial SCCs and their
      // hard/unsatisfied dependents) so acyclic consumers with only optional
      // (`required: false`) bindings, `after` edges, or already-satisfied
      // `cardinality: "one"` bindings pointing into dead cycles still run.
      const stuckNodes = new Set(inDegree.keys());
      const dead = findCycleNodes(stuckNodes, directDependencies);
      let changed = true;
      while (changed) {
        changed = false;
        for (const name of stuckNodes) {
          if (dead.has(name)) continue;
          const deps = directDependencies.get(name)!;
          const hard = hardDependencies.get(name)!;
          const blockedByHardDead = [...deps].some(
            (dep) => dead.has(dep) && hard.has(dep),
          );
          const groups = oneProviderGroups.get(name) ?? [];
          const blockedByDoomedGroup = groups.some(
            (group) =>
              !group.some((provider) => completed.has(provider)) &&
              !group.some(
                (provider) => inDegree.has(provider) && !dead.has(provider),
              ),
          );
          if (blockedByHardDead || blockedByDoomedGroup) {
            dead.add(name);
            changed = true;
          }
        }
      }
      for (const name of stuckNodes) {
        if (dead.has(name)) continue;
        const remaining = [...directDependencies.get(name)!].filter((dep) =>
          inDegree.has(dep),
        );
        if (remaining.length === 0) continue;
        // Wait for any alive upstream first; only drop blockers known to be dead.
        if (!remaining.every((dep) => dead.has(dep))) continue;
        if (!hasUnsatisfiedOneGroup(oneProviderGroups.get(name) ?? [])) {
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
