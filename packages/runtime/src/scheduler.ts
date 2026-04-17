/**
 * Priority Scheduler — groups and orders runtimes by priority, filtered
 * by turn-number band.
 *
 * Band rules (hard-enforced by the kernel):
 *   turn === 0 → only priority [0, 99] scheduled (Pre-Game band)
 *   turn >= 1  → only priority [100, 1000] scheduled (main loop)
 */

import type { RuntimeManifest } from '@covel/shared';
import type { ScheduledGroup } from './types.js';

const PRE_GAME_BAND_MAX = 99;

function isInBand(priority: number | undefined, turnNumber: number): boolean {
  if (priority === undefined) return false; // UI-only / no-schedule runtimes
  if (turnNumber === 0) return priority <= PRE_GAME_BAND_MAX;
  return priority > PRE_GAME_BAND_MAX;
}

/**
 * Group runtimes by priority and sort groups ascending (0 = highest priority = first).
 * Runtimes out of the current turn's band are dropped silently.
 * Runtimes with `priority === undefined` (UI-only plugins) are never scheduled.
 */
export function scheduleByPriority(
  runtimes: readonly RuntimeManifest[],
  turnNumber: number,
): readonly ScheduledGroup[] {
  if (runtimes.length === 0) return [];

  const inBand = runtimes.filter(
    (rt): rt is RuntimeManifest & { priority: number } => isInBand(rt.priority, turnNumber),
  );
  if (inBand.length === 0) return [];

  const grouped = new Map<number, RuntimeManifest[]>();
  for (const rt of inBand) {
    const existing = grouped.get(rt.priority);
    if (existing !== undefined) {
      existing.push(rt);
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
