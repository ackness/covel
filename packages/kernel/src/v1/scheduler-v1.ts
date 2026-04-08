import type { V1Candidate, V1ExecutionPlan, V1PriorityGroup } from "./types.js";

/**
 * V1 Scheduler.
 *
 * Groups candidates by priority (ascending: lower number = executes first).
 * Same priority runtimes form a parallel group.
 */
export function buildV1ExecutionPlan(candidates: V1Candidate[]): V1ExecutionPlan {
  if (candidates.length === 0) return { groups: [] };

  // Group by priority
  const priorityMap = new Map<number, V1Candidate[]>();
  for (const c of candidates) {
    const p = c.runtime.manifest.priority;
    if (!priorityMap.has(p)) priorityMap.set(p, []);
    priorityMap.get(p)!.push(c);
  }

  // Sort priorities ascending (lower number = first)
  const sortedPriorities = Array.from(priorityMap.keys()).sort((a, b) => a - b);

  const groups: V1PriorityGroup[] = sortedPriorities.map((priority) => ({
    priority,
    runtimes: priorityMap.get(priority)!,
  }));

  return { groups };
}
