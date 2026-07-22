/**
 * Runtime execution engine types.
 */

import type { RuntimeManifest } from "@covel/shared";

// ── Trigger evaluation ───────────────────────────────────────────

export interface TriggerContext {
  readonly sessionId: string;
  /** Global player-message counter. 0-based from session start. */
  readonly turnNumber: number;
  /**
   * The player's logical-turn number for this execution: `completedPlayerTurns
   * + 1`. Counts only committed main-loop player turns (setup interactions do
   * not advance it), so `scheduled` cadence and `startTurn` gate on the real
   * turn number rather than the raw player-message count. Frozen at execution
   * start. Production selection always sets it; when a caller omits it (legacy
   * test builders), `shouldTrigger` falls back to `turnNumber`.
   */
  readonly logicalTurn?: number;
  /** How many times this runtime has been triggered in this session. */
  readonly triggerCount: number;
  /** Turns since last trigger. */
  readonly turnsSinceLastTrigger: number;
  /** Pending events (for event-type triggers). */
  readonly pendingEventTopics: readonly string[];
  /** Whether this is a manual trigger request for this specific runtime. */
  readonly isManualTrigger: boolean;
  /** RuntimeIds already in the session's preGameCompleted set — used to skip
   *  Pre-Game runtimes that are already done during Turn 0 iteration. */
  readonly preGameCompleted: readonly string[];
}

// ── Scheduling ───────────────────────────────────────────────────

export interface ScheduledGroup {
  readonly priority: number;
  readonly runtimes: readonly RuntimeManifest[];
}
