/**
 * Priority Scheduler — groups and orders runtimes by priority, filtered
 * by turn-number band.
 *
 * Band rules (hard-enforced by the kernel):
 *   turn === 0 → only priority [0, 99] scheduled (Pre-Game band)
 *   turn >= 1  → only priority [100, 1000] scheduled (main loop)
 */

import type { RuntimeManifest } from "@covel/shared";
import type { ScheduledGroup } from "./types.js";

const PRE_GAME_BAND_MIN = 0;
const PRE_GAME_BAND_MAX = 99;
const MAIN_BAND_MIN = 100;
const MAIN_BAND_MAX = 1000;

/**
 * Narrator band priority (500, per the kernel band table). Also the implicit
 * default for any runtime that omits `priority` — used when ordering narrative
 * messages and when sorting a priority-less runtime within the main loop.
 */
export const NARRATOR_PRIORITY = 500;

export function isPreGamePriority(
  priority: number | undefined,
): priority is number {
  return (
    priority !== undefined &&
    priority >= PRE_GAME_BAND_MIN &&
    priority <= PRE_GAME_BAND_MAX
  );
}

export function isMainLoopPriority(
  priority: number | undefined,
): priority is number {
  return (
    priority !== undefined &&
    priority >= MAIN_BAND_MIN &&
    priority <= MAIN_BAND_MAX
  );
}

function isInBand(priority: number | undefined, turnNumber: number): boolean {
  // UI-only runtimes (e.g. memory, trigger.type='manual' with no
  // priority) are never scheduled. This is the defence that keeps
  // manifest typos from accidentally enqueueing a pure-UI plugin and
  // tripping the LLM pipeline on a runtime that has no handler or prompt.
  if (priority === undefined) return false;
  if (turnNumber === 0) return isPreGamePriority(priority);
  return isMainLoopPriority(priority);
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
    (rt): rt is RuntimeManifest & { priority: number } =>
      isInBand(rt.priority, turnNumber),
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
