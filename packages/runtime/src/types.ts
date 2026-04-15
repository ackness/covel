/**
 * Runtime execution engine types.
 */

import type { RuntimeManifest } from '@covel/shared';

// ── Trigger evaluation ───────────────────────────────────────────

export interface TriggerContext {
  readonly sessionId: string;
  /**
   * Global player-message counter. 0-based from session start, includes all
   * phases (pre-game, character_creation, playing, ...). Use for interval /
   * cooldown scheduling that should run across the whole session.
   */
  readonly turnNumber: number;
  /**
   * Playing-phase turn counter (PR-2). 0-based from when the session first
   * entered `playing` phase. `0` while the session is still pre-game or
   * has never entered playing. Plugin authors' `trigger.startTurn` is
   * compared against THIS value — "from the N-th round of actual gameplay"
   * rather than "from session start".
   */
  readonly playingTurnNumber: number;
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

