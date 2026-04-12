/**
 * Runtime execution engine types.
 */

import type { RuntimeManifest } from '@covel/shared';

// ── Trigger evaluation ───────────────────────────────────────────

export interface TriggerContext {
  readonly sessionId: string;
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
  /** Current session phase (e.g. 'pre-game', 'character_creation', 'playing'). */
  readonly sessionPhase?: string;
}

// ── Scheduling ───────────────────────────────────────────────────

export interface ScheduledGroup {
  readonly priority: number;
  readonly runtimes: readonly RuntimeManifest[];
}

