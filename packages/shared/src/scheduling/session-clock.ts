/**
 * Session-clock dual-write formula (pure).
 *
 * The scheduling redesign makes `phase` / `completedPlayerTurns` /
 * `setupRuntimes` the business truth for a session's position in its lifecycle.
 * The legacy band/gate fields `turnCount` / `preGameCompleted` remain as
 * columns for old-kernel / rollback compatibility, but the kernel no longer
 * writes them: consumers DERIVE them at read time from the clock via
 * `deriveLegacyClockForSession`. `deriveLegacyClockFields` is the pure formula
 * both the read-time derivation and the one-time legacy backfill share, so
 * every path agrees byte-for-byte.
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
 *  - `turnCount`: the legacy band selector. `setup` → 0 (Pre-Game band).
 *    `playing` → `max(1, completedPlayerTurns)` — the Pre-Game floor — but ONLY
 *    once the session shows progress (a completed player turn OR a completed
 *    setup runtime). A session that started directly in `playing` with no setup
 *    and no turns yet (a bare, plugin-less session) reports 0, matching the
 *    legacy create value and keeping the backfill round-trip (0 → playing → 0)
 *    lossless.
 *  - `preGameCompleted`: the runtimeIds of every setup runtime whose mirror is
 *    `done`, sorted for a stable value.
 */
export function deriveLegacyClockFields(
  clock: SessionClock,
): LegacyClockFields {
  const doneSetup = Object.entries(clock.setupRuntimes).filter(
    ([, state]) => state.state === "done",
  );
  const hasProgress = clock.completedPlayerTurns > 0 || doneSetup.length > 0;
  const turnCount =
    clock.phase === "setup" || !hasProgress
      ? 0
      : Math.max(1, clock.completedPlayerTurns);
  const preGameCompleted = doneSetup.map(([runtimeId]) => runtimeId).sort();
  return { turnCount, preGameCompleted };
}

/**
 * Read-time legacy-clock derivation for a persisted session row.
 *
 * The kernel no longer double-writes `turnCount` / `preGameCompleted` — the
 * clock (`phase` / `completedPlayerTurns` / `setupRuntimes`) is the sole write
 * surface, and the persisted legacy columns are frozen at their last written
 * value. Every consumer that needs the legacy shape derives it here instead of
 * reading the stale column, keeping API responses / snapshots byte-shape
 * identical. Legacy rows written before `phase` existed (undefined) fall back
 * to their raw columns — the one-time backfill upgrades them on next turn.
 */
export function deriveLegacyClockForSession(session: {
  readonly phase?: "setup" | "playing";
  readonly completedPlayerTurns?: number;
  readonly setupRuntimes?: Readonly<Record<string, SetupRuntimeState>>;
  readonly turnCount?: number;
  readonly preGameCompleted?: readonly string[];
}): LegacyClockFields {
  if (session.phase === undefined) {
    return {
      turnCount: session.turnCount ?? 0,
      preGameCompleted: [...(session.preGameCompleted ?? [])],
    };
  }
  return deriveLegacyClockFields({
    phase: session.phase,
    completedPlayerTurns: session.completedPlayerTurns ?? 0,
    setupRuntimes: session.setupRuntimes ?? {},
  });
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
