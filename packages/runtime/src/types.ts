/**
 * Runtime execution engine types.
 */

import type { RuntimeManifest } from "@covel/shared";

// ── Trigger evaluation ───────────────────────────────────────────

export interface TriggerContext {
  readonly sessionId: string;
  /** Global player-message counter. 0-based from session start. */
  readonly turnNumber: number;
  /** How many times this runtime has been triggered in this session. */
  readonly triggerCount: number;
  /** Turns since last trigger. */
  readonly turnsSinceLastTrigger: number;
  /** Pending events (for event-type triggers). */
  readonly pendingEventTopics: readonly string[];
  /** Whether an upstream runtime has failed. */
  readonly hasUpstreamFailure: boolean;
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
