/**
 * DAG scheduler — topological-level scheduling for the main-loop band.
 *
 * Priority scheduling treats every same-priority bucket as parallel and
 * everything else as strictly serial by number, which forces independent
 * branches to wait on each other (e.g. `codex` blocking on
 * `npc-graph/extractor` just because 620 < 650, even though they
 * both only depend on `narrator`).
 *
 * The DAG scheduler derives dependencies from each manifest's declared
 * injects (`input.inject[].from` where `kind === 'runtime'`) and explicit
 * `upstreamRequired[]`, performs a Kahn-style topological sort, and returns
 * "levels" — each level is a set of runtimes whose dependencies have all
 * completed and may therefore run concurrently. Within a level, runtimes are
 * ordered by name so traces stay readable and ties break deterministically.
 * A level runs via `executeParallel` (Promise.allSettled), so the intra-level
 * order is cosmetic — it does not drive the committed narrative order, which
 * follows real completion time (`createdAt`).
 *
 * Dependencies that point to runtimes outside `activeRuntimes` are ignored
 * (the scheduler only knows about runtimes in scope). Cycles are reported via
 * the returned `error` field; callers should fall back to `scheduleByPriority`
 * when a cycle is present.
 *
 * Pre-Game band (priority ≤ 99) intentionally keeps strict priority ordering
 * — Pre-Game plugins have implicit write-ordering (pregame → player-init →
 * world-init) that is not captured in `input.inject`. Callers should only
 * route the main-loop band through this scheduler.
 */

import type { RuntimeManifest } from "@covel/shared";
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

function collectDependencies(
  manifest: RuntimeManifest,
  capabilityProviders: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const deps = new Set<string>();
  const injects = manifest.input?.inject ?? [];
  for (const decl of injects) {
    if (decl.kind === "runtime") {
      if (decl.from.length > 0) deps.add(decl.from);
    }
  }
  for (const up of manifest.upstreamRequired ?? []) {
    if (typeof up === "string") {
      if (up.length > 0) deps.add(up);
    } else {
      // Capability upstream — depend on every in-scope provider of it so the
      // level ordering waits for whichever provider the current mode loaded.
      for (const name of capabilityProviders.get(up.capability) ?? []) {
        deps.add(name);
      }
    }
  }
  // `inputs` bindings imply ordering edges too: `required: true` → needs(turn),
  // `false` → after — both need the producer scheduled first. Runtime/capability
  // resolution mirrors upstreamRequired above.
  for (const binding of Object.values(getRuntimeSpec(manifest).bindings)) {
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
 * Topologically sort `runtimes` into levels. Returns one group per level;
 * each group carries its level index in the synthetic `priority` field
 * (telemetry only — nothing schedules on it; kept as a number until Step 6
 * removes the field).
 */
export function scheduleByDag(
  runtimes: readonly RuntimeManifest[],
): DagScheduleResult {
  if (runtimes.length === 0) return { groups: [] };

  // Build the in-scope set first so out-of-scope deps are ignored cleanly.
  const inScope = new Set(runtimes.map((r) => r.name));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const byName = new Map<string, RuntimeManifest>();

  // capability → in-scope runtime names that declare it, for resolving
  // `{ capability }` upstream entries into concrete dependency edges.
  const capabilityProviders = new Map<string, string[]>();
  for (const rt of runtimes) {
    byName.set(rt.name, rt);
    inDegree.set(rt.name, 0);
    for (const cap of rt.capabilities ?? []) {
      const list = capabilityProviders.get(cap) ?? [];
      list.push(rt.name);
      capabilityProviders.set(cap, list);
    }
  }

  for (const rt of runtimes) {
    const deps = collectDependencies(rt, capabilityProviders);
    for (const dep of deps) {
      if (!inScope.has(dep)) continue; // out-of-scope — treat as satisfied
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
    const ready = pickReady();
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

    // Synthetic telemetry value = level index (no priority read).
    levels.push({ priority: levels.length, runtimes: ready });

    for (const rt of ready) {
      inDegree.delete(rt.name);
      for (const down of dependents.get(rt.name) ?? []) {
        const next = (inDegree.get(down) ?? 0) - 1;
        inDegree.set(down, next);
      }
    }
  }

  return { groups: levels };
}
