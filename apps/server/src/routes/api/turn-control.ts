/**
 * In-flight turn control registry — one entry per session with
 * an active player-initiated turn. The actions route registers on turn
 * start and releases on stream end; the steer/abort routes look entries up
 * to inject player interjections or fire the abort signal.
 *
 * ponytail: in-process map — on multi-pod PG deployments steer/abort only
 * reach turns running on the same pod; move to a shared bus if that tier
 * ever needs cross-pod turn control.
 */

import type { TurnControl } from "@covel/runtime";

interface ActiveTurnEntry {
  readonly turnId: string;
  readonly requestId?: string;
  readonly startedAt: string;
  readonly controller: AbortController;
  /** Accepted interjections no model call has read yet, oldest first. */
  readonly steering: string[];
  /** Every interjection accepted for the turn, in arrival order. */
  readonly accepted: TurnInterjection[];
  /** How many of `accepted` a model call has read. */
  read: number;
  /** False once no runtime of the execution reads the queue any more. */
  steeringOpen: boolean;
}

/**
 * `turn_messages.sourceType` of a saved interjection: a user row of its turn
 * that the prompt history shows, but not a player turn of its own (the turn
 * count reads only `player` rows).
 */
export const PLAYER_INTERJECTION_SOURCE = "player-interjection";

/** A player interjection accepted for a turn; saved only if the turn commits. */
export interface TurnInterjection {
  readonly content: string;
  /** When a model call of the turn read it; absent when none did. */
  readonly readAt?: string;
}

const activeTurns = new Map<string, ActiveTurnEntry>();

/** Why an interjection was not queued; also the code of the 409 response. */
export type SteerRefusal = "no_active_turn" | "steering_closed";

export interface RegisteredTurn {
  readonly turnControl: TurnControl;
  /**
   * In the turn's commit: stop accepting interjections and hand over every
   * one accepted, so they are saved with the turn or not at all.
   */
  readonly closeInterjections: () => readonly TurnInterjection[];
  readonly release: () => void;
}

/**
 * Register the in-flight turn for a session. A newer registration replaces
 * a stale one (a crashed stream that never released); release is idempotent
 * and only removes its own entry.
 */
export function registerActiveTurn(
  sessionId: string,
  turnId: string,
  requestId?: string,
): RegisteredTurn {
  const entry: ActiveTurnEntry = {
    turnId,
    requestId,
    startedAt: new Date().toISOString(),
    controller: new AbortController(),
    steering: [],
    accepted: [],
    read: 0,
    steeringOpen: true,
  };
  activeTurns.set(sessionId, entry);
  return {
    turnControl: {
      signal: entry.controller.signal,
      drainSteering: () => {
        const drained = entry.steering.splice(0);
        const readAt = new Date().toISOString();
        for (let i = 0; i < drained.length; i += 1) {
          const index = entry.read + i;
          entry.accepted[index] = { ...entry.accepted[index]!, readAt };
        }
        entry.read += drained.length;
        return drained;
      },
      closeSteering: () => {
        entry.steeringOpen = false;
      },
    },
    closeInterjections: () => {
      entry.steeringOpen = false;
      return [...entry.accepted];
    },
    release: () => {
      if (activeTurns.get(sessionId) === entry) activeTurns.delete(sessionId);
    },
  };
}

/**
 * Queue a player interjection into the session's active turn. Refused when
 * the session has no turn in flight, and when the turn can no longer read it:
 * the player aborted it, or every runtime that reads interjections finished.
 */
export function steerActiveTurn(
  sessionId: string,
  message: string,
): { turnId: string } | { refused: SteerRefusal } {
  const entry = activeTurns.get(sessionId);
  if (!entry) return { refused: "no_active_turn" };
  if (!entry.steeringOpen || entry.controller.signal.aborted) {
    return { refused: "steering_closed" };
  }
  entry.steering.push(message);
  entry.accepted.push({ content: message });
  return { turnId: entry.turnId };
}

/** Abort the session's active turn. Idempotent. */
export function abortActiveTurn(sessionId: string): { turnId: string } | null {
  const entry = activeTurns.get(sessionId);
  if (!entry) return null;
  entry.controller.abort();
  return { turnId: entry.turnId };
}

/** Introspection for tests. */
export function hasActiveTurn(sessionId: string): boolean {
  return activeTurns.has(sessionId);
}

/** Safe public metadata; abort controllers and steering content stay private. */
export function getActiveTurn(sessionId: string): {
  turnId: string;
  requestId?: string;
  startedAt: string;
} | null {
  const entry = activeTurns.get(sessionId);
  return entry
    ? {
        turnId: entry.turnId,
        requestId: entry.requestId,
        startedAt: entry.startedAt,
      }
    : null;
}
