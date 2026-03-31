import type { RuntimePhase } from "@covel/shared";
import type { CandidateRuntime, ScheduledRuntime, ExecutionPlan } from "../types.js";

/** Phase execution order. */
const PHASE_ORDER: RuntimePhase[] = [
  "pre_story",
  "story",
  "post_story",
  "background",
];

/**
 * Build an execution plan from candidate runtimes.
 *
 * 1. Group by phase
 * 2. Within each phase, compute topological layers based on plugin `requires`
 * 3. Same layer executes in parallel; layers execute sequentially
 */
export function buildExecutionPlan(
  candidates: CandidateRuntime[],
  pluginDeps: Map<string, string[]>
): ExecutionPlan {
  const groups: ScheduledRuntime[][] = [];

  // Group candidates by phase
  const byPhase = new Map<RuntimePhase, CandidateRuntime[]>();
  for (const c of candidates) {
    const phase = c.registered.spec.phase;
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase)!.push(c);
  }

  // Process phases in order
  for (const phase of PHASE_ORDER) {
    const phaseCandidates = byPhase.get(phase);
    if (!phaseCandidates || phaseCandidates.length === 0) continue;

    // Compute topological layers for this phase
    const layered = computeTopoLayers(phaseCandidates, pluginDeps);

    for (const layer of layered) {
      if (layer.length > 0) {
        groups.push(layer);
      }
    }
  }

  return { groups };
}

/**
 * Compute topological layers using Kahn's algorithm variant.
 *
 * Runtimes with no dependencies go to layer 0.
 * Runtimes depending on layer-N plugins go to layer N+1.
 */
function computeTopoLayers(
  candidates: CandidateRuntime[],
  pluginDeps: Map<string, string[]>
): ScheduledRuntime[][] {
  // Build a map from pluginId to candidates in this group
  const pluginCandidates = new Map<string, CandidateRuntime[]>();
  for (const c of candidates) {
    const pid = c.registered.pluginId;
    if (!pluginCandidates.has(pid)) pluginCandidates.set(pid, []);
    pluginCandidates.get(pid)!.push(c);
  }

  // Compute in-degree based on plugin dependencies within this group
  const presentPlugins = new Set(pluginCandidates.keys());
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

  let layerIndex = 0;

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
          phase: c.registered.spec.phase,
          topoLayer: layerIndex,
        });
      }

      // Reduce in-degree of dependents
      for (const depId of dependents.get(pid) ?? []) {
        const deg = (inDegree.get(depId) ?? 1) - 1;
        inDegree.set(depId, deg);
        if (deg === 0) nextQueue.push(depId);
      }
    }

    if (layer.length > 0) {
      layers.push(layer);
    }

    currentQueue = nextQueue;
    layerIndex++;
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
        phase: c.registered.spec.phase,
        topoLayer: layerIndex,
      });
    }
  }
  if (remaining.length > 0) {
    layers.push(remaining);
  }

  return layers;
}
