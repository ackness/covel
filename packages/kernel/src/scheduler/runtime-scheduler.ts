import type { CandidateRuntime, ScheduledRuntime, ExecutionPlan } from "../types.js";
import { DEFAULT_RUNTIME_PRIORITY } from "../types.js";

/**
 * Build an execution plan from candidate runtimes using priority-based scheduling.
 *
 * 1. Resolve each runtime's effective priority (override ?? spec.priority ?? 500)
 * 2. Sort all candidates by priority ascending (0 = highest = runs first)
 * 3. Group candidates with the same priority into parallel execution groups
 * 4. Within same-priority groups, split by plugin dependencies (dependent runs after)
 *
 * @param priorityOverrides Optional per-runtime priority overrides keyed by
 *   qualified runtime ID ("pluginId:runtimeId").
 */
export function buildExecutionPlan(
  candidates: CandidateRuntime[],
  pluginDeps: Map<string, string[]>,
  priorityOverrides?: Readonly<Record<string, number>>
): ExecutionPlan {
  if (candidates.length === 0) return { groups: [] };

  // Resolve effective priority for each candidate (override > spec > default)
  const withPriority = candidates.map((c) => {
    const qualifiedId = `${c.registered.pluginId}:${c.registered.spec.id}`;
    const override = priorityOverrides?.[qualifiedId];
    return {
      candidate: c,
      priority: override ?? c.registered.spec.priority ?? DEFAULT_RUNTIME_PRIORITY,
    };
  });

  // Sort by priority ascending
  withPriority.sort((a, b) => a.priority - b.priority);

  // Group by priority
  const priorityGroups = new Map<number, CandidateRuntime[]>();
  for (const { candidate, priority } of withPriority) {
    if (!priorityGroups.has(priority)) priorityGroups.set(priority, []);
    priorityGroups.get(priority)!.push(candidate);
  }

  // Process each priority group, splitting by deps within the group
  const groups: ScheduledRuntime[][] = [];
  const sortedPriorities = Array.from(priorityGroups.keys()).sort((a, b) => a - b);

  for (const priority of sortedPriorities) {
    const groupCandidates = priorityGroups.get(priority)!;
    const subGroups = splitByDependencies(groupCandidates, pluginDeps, priority);
    for (const sub of subGroups) {
      if (sub.length > 0) groups.push(sub);
    }
  }

  return { groups };
}

/**
 * Within a same-priority group, split candidates into sub-groups
 * based on plugin dependencies using topological layering.
 * Independent runtimes run in parallel; dependent ones run after.
 */
function splitByDependencies(
  candidates: CandidateRuntime[],
  pluginDeps: Map<string, string[]>,
  priority: number
): ScheduledRuntime[][] {
  // Build map from pluginId to candidates
  const pluginCandidates = new Map<string, CandidateRuntime[]>();
  for (const c of candidates) {
    const pid = c.registered.pluginId;
    if (!pluginCandidates.has(pid)) pluginCandidates.set(pid, []);
    pluginCandidates.get(pid)!.push(c);
  }

  const presentPlugins = new Set(pluginCandidates.keys());

  // Check if there are any relevant dependencies within this group
  let hasDeps = false;
  for (const pid of presentPlugins) {
    const deps = pluginDeps.get(pid) ?? [];
    if (deps.some((d) => presentPlugins.has(d))) {
      hasDeps = true;
      break;
    }
  }

  // Fast path: no deps within group, all run in parallel
  if (!hasDeps) {
    const layer: ScheduledRuntime[] = candidates.map((c) => ({
      registered: c.registered,
      triggerEvent: c.triggerEvent,
      priority,
    }));
    return [layer];
  }

  // Compute in-degree for topological layering
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();

  for (const pid of presentPlugins) {
    inDegree.set(pid, 0);
  }

  for (const pid of presentPlugins) {
    const deps = pluginDeps.get(pid) ?? [];
    for (const dep of deps) {
      if (presentPlugins.has(dep)) {
        inDegree.set(pid, (inDegree.get(pid) ?? 0) + 1);
        if (!dependents.has(dep)) dependents.set(dep, new Set());
        dependents.get(dep)!.add(pid);
      }
    }
  }

  // Kahn's algorithm to produce layers
  const layers: ScheduledRuntime[][] = [];
  let currentQueue = Array.from(presentPlugins).filter(
    (pid) => (inDegree.get(pid) ?? 0) === 0
  );

  while (currentQueue.length > 0) {
    const layer: ScheduledRuntime[] = [];
    const nextQueue: string[] = [];

    // Sort for deterministic ordering
    currentQueue.sort();

    for (const pid of currentQueue) {
      const runtimes = pluginCandidates.get(pid) ?? [];
      for (const c of runtimes) {
        layer.push({
          registered: c.registered,
          triggerEvent: c.triggerEvent,
          priority,
        });
      }

      for (const depId of dependents.get(pid) ?? []) {
        const deg = (inDegree.get(depId) ?? 1) - 1;
        inDegree.set(depId, deg);
        if (deg === 0) nextQueue.push(depId);
      }
    }

    if (layer.length > 0) layers.push(layer);
    currentQueue = nextQueue;
  }

  // Remaining candidates with unresolved deps go to last layer
  const scheduled = new Set(
    layers.flat().map((s) => `${s.registered.pluginId}:${s.registered.spec.id}`)
  );
  const remaining: ScheduledRuntime[] = [];
  for (const c of candidates) {
    const qid = `${c.registered.pluginId}:${c.registered.spec.id}`;
    if (!scheduled.has(qid)) {
      remaining.push({
        registered: c.registered,
        triggerEvent: c.triggerEvent,
        priority,
      });
    }
  }
  if (remaining.length > 0) layers.push(remaining);

  return layers;
}
