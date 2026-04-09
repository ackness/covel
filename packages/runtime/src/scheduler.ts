/**
 * Priority Scheduler — groups and orders runtimes by priority.
 */

import type { RuntimeManifest } from '@covel/shared';
import type { ScheduledGroup, DependencyEdge } from './types.js';

/**
 * Group runtimes by priority and sort groups ascending (0 = highest priority = first).
 * Runtimes with the same priority are in the same group (parallel candidates).
 */
export function scheduleByPriority(
  runtimes: readonly RuntimeManifest[],
): readonly ScheduledGroup[] {
  if (runtimes.length === 0) {
    return [];
  }

  const grouped = new Map<number, RuntimeManifest[]>();

  for (const rt of runtimes) {
    const existing = grouped.get(rt.priority);
    if (existing !== undefined) {
      grouped.set(rt.priority, [...existing, rt]);
    } else {
      grouped.set(rt.priority, [rt]);
    }
  }

  const sortedPriorities = [...grouped.keys()].sort((a, b) => a - b);

  return sortedPriorities.map((priority) => ({
    priority,
    runtimes: grouped.get(priority)!,
  }));
}

/**
 * Extract dependency edges from runtime manifests.
 * Dependencies come from `input.inject[].from` and `input.tools[].plugin/runtime`.
 *
 * Returns edges as { dependent, dependency } pairs where values are runtime names.
 */
export function extractDependencies(
  runtimes: readonly RuntimeManifest[],
): readonly DependencyEdge[] {
  const edges: DependencyEdge[] = [];

  for (const rt of runtimes) {
    const input = rt.input;
    if (input === undefined) {
      continue;
    }

    if (input.inject !== undefined) {
      for (const inj of input.inject) {
        edges.push({ dependent: rt.name, dependency: inj.from });
      }
    }

    if (input.tools !== undefined) {
      for (const tool of input.tools) {
        edges.push({ dependent: rt.name, dependency: `${tool.plugin}/${tool.runtime}` });
      }
    }
  }

  return edges;
}

/**
 * Detect circular dependencies in the dependency graph.
 * Returns arrays of cycle paths, or empty array if no cycles.
 */
export function detectCycles(
  edges: readonly DependencyEdge[],
): readonly (readonly string[])[] {
  if (edges.length === 0) {
    return [];
  }

  // Build adjacency list
  const adjacency = new Map<string, string[]>();
  const allNodes = new Set<string>();

  for (const edge of edges) {
    allNodes.add(edge.dependent);
    allNodes.add(edge.dependency);
    const neighbors = adjacency.get(edge.dependent);
    if (neighbors !== undefined) {
      neighbors.push(edge.dependency);
    } else {
      adjacency.set(edge.dependent, [edge.dependency]);
    }
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycles: (readonly string[])[] = [];

  function dfs(node: string, path: string[]): void {
    visited.add(node);
    inStack.add(node);
    path.push(node);

    const neighbors = adjacency.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (inStack.has(neighbor)) {
        // Found a cycle: extract from where the neighbor appears in the path
        const cycleStart = path.indexOf(neighbor);
        const cycle = path.slice(cycleStart);
        cycles.push(cycle);
      } else if (!visited.has(neighbor)) {
        dfs(neighbor, path);
      }
    }

    path.pop();
    inStack.delete(node);
  }

  for (const node of allNodes) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return cycles;
}
