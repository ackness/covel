/**
 * Session-clock dual-write formula (pure).
 *
 * The scheduling redesign makes `phase` / `completedPlayerTurns` /
 * `setupRuntimes` the business truth for a session's position in its lifecycle.
 * The legacy band/gate fields `turnCount` / `preGameCompleted` remain on the
 * record for backward compatibility but are now DERIVED from the clock, never
 * written independently. This module is the single source of that derivation so
 * every writer (finalize transaction, session creation, legacy backfill, fork)
 * agrees byte-for-byte.
 */

import type { SetupRuntimeState } from "../types/runtime-lifecycle.js";

export interface SessionClock {
  readonly phase: "setup" | "playing";
  readonly completedPlayerTurns: number;
  readonly setupRuntimes: Readonly<Record<string, SetupRuntimeState>>;
}

export interface LegacyClockFields {
  readonly turnCount: number;
  readonly preGameCompleted: string[];
}

/**
 * Derive the legacy `turnCount` / `preGameCompleted` fields from the clock.
 *
 *  - `turnCount`: the legacy band selector. `setup` → 0 (Pre-Game band);
 *    `playing` → `max(1, completedPlayerTurns)`. The `max(1, …)` encodes the
 *    Pre-Game floor: a session that just crossed into `playing` reports 1 even
 *    though no player turn has been counted yet.
 *  - `preGameCompleted`: the runtimeIds of every setup runtime whose mirror is
 *    `done`, sorted for a stable value.
 */
export function deriveLegacyClockFields(
  clock: SessionClock,
): LegacyClockFields {
  const turnCount =
    clock.phase === "setup" ? 0 : Math.max(1, clock.completedPlayerTurns);
  const preGameCompleted = Object.entries(clock.setupRuntimes)
    .filter(([, state]) => state.state === "done")
    .map(([runtimeId]) => runtimeId)
    .sort();
  return { turnCount, preGameCompleted };
}

/**
 * Mirror a setup runtime that reported done into a `SetupRuntimeState`.
 *
 * Minimal for this wave: `resolution: "completed"`, `generation: 1`,
 * `attempts: 0` (placeholder until the attempt ledger feeds it). The `blocked`
 * path and real attempt accounting land in a later wave.
 */
export function mirrorSetupDone(
  pluginVersion: string,
  completedAt: string,
): Extract<SetupRuntimeState, { state: "done" }> {
  return {
    state: "done",
    resolution: "completed",
    generation: 1,
    attempts: 0,
    completedAt,
    pluginVersion,
  };
}

/** Mirror a set of already-completed setup runtimeIds as `done` records. */
export function mirrorSetupCompleted(
  runtimeIds: readonly string[],
  completedAt: string,
): Record<string, SetupRuntimeState> {
  const mirror: Record<string, SetupRuntimeState> = {};
  for (const id of runtimeIds) {
    mirror[id] = mirrorSetupDone("0.0.0", completedAt);
  }
  return mirror;
}
