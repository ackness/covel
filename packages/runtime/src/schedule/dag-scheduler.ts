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
 * ordered by `priority` ascending so traces stay readable and so ties break
 * deterministically.
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
import type { ScheduledGroup } from "../types.js";

export interface DagScheduleResult {
  readonly groups: readonly ScheduledGroup[];
  readonly error?: string;
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
  return [...deps];
}

/**
 * Topologically sort `runtimes` into levels. Returns one group per level;
 * each group keeps the synthetic `priority` field populated for telemetry,
 * using the lowest priority inside that level.
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
  // Ready = runtimes with inDegree 0, sorted by priority asc then name asc.
  const pickReady = (): RuntimeManifest[] => {
    const ready: RuntimeManifest[] = [];
    for (const [name, deg] of inDegree) {
      if (deg === 0) {
        const rt = byName.get(name);
        if (rt) ready.push(rt);
      }
    }
    ready.sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa !== pb) return pa - pb;
      return a.name.localeCompare(b.name);
    });
    return ready;
  };

  while (inDegree.size > 0) {
    const ready = pickReady();
    if (ready.length === 0) {
      // Cycle — return what we built so far with an error. Caller may fall
      // back to the priority scheduler.
      return {
        groups: levels,
        error: `cycle detected among runtimes: ${[...inDegree.keys()].join(", ")}`,
      };
    }

    const priority = ready[0]!.priority ?? 0;
    levels.push({ priority, runtimes: ready });

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
