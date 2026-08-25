/** Session lifecycle clock used by scheduling and persistence. */

import type { SetupRuntimeState } from "../types/runtime-lifecycle.js";

export interface SessionClock {
  readonly phase: "setup" | "playing";
  readonly completedPlayerTurns: number;
  readonly setupRuntimes: Readonly<Record<string, SetupRuntimeState>>;
}

/**
 * Mirror a setup runtime that reported done into a `SetupRuntimeState`.
 *
 * The caller supplies the active generation and terminal-attempt count so the
 * session mirror stays consistent with the setup-attempt ledger.
 */
export function mirrorSetupDone(
  pluginVersion: string,
  completedAt: string,
  generation: number,
  attempts: number,
): Extract<SetupRuntimeState, { state: "done" }> {
  return {
    state: "done",
    resolution: "completed",
    generation,
    attempts,
    completedAt,
    pluginVersion,
  };
}
