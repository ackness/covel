/**
 * Priority Scheduler — groups and orders runtimes by priority.
 */

import type { RuntimeManifest } from '@covel/shared';
import type { ScheduledGroup } from './types.js';

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
