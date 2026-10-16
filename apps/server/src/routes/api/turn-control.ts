/**
 * In-flight turn control registry — one entry per player action request.
 * The actions route registers a request when it is admitted, makes it the
 * session's active turn under the lock, and releases it on stream end; the
 * steer/abort routes look entries up to inject player interjections or fire
 * the request's abort signal.
 *
 * ponytail: in-process map — on multi-pod PG deployments steer/abort only
 * reach turns running on the same pod; move to a shared bus if that tier
 * ever needs cross-pod turn control.
 */

import type { TurnControl } from "@covel/runtime";

interface ActionEntry {
  readonly requestId?: string;
  readonly startedAt: string;
  /** One per action request: a stop applies to the request, not one turn. */
  readonly controller: AbortController;
  /** The turn the request runs now, or will run next. */
  turnId: string;
  readonly steering: string[];
  /** Every interjection accepted since the last turn commit. */
  readonly accepted: TurnInterjection[];
  /** How many of `accepted` a model call has read. */
  read: number;
  /** False once no runtime of the execution reads the queue any more. */
  steeringOpen: boolean;
  /** No further turn of the request will start: a stop has nothing to stop. */
  finished: boolean;
}

/** Saved user rows of a turn, excluded from the player-turn count. */
export const PLAYER_INTERJECTION_SOURCE = "player-interjection";

/** A player interjection saved only if its turn commits. */
export interface TurnInterjection {
  readonly content: string;
  /** When a model call read it; absent when none did. */
  readonly readAt?: string;
}

/** The request holding (or last holding) each session's execution lock. */
const activeTurns = new Map<string, ActionEntry>();
/** Admitted requests that have not taken the execution lock yet. */
const waitingRequests = new Map<string, Set<ActionEntry>>();

/** Why an interjection was not queued; also the code of the 409 response. */
export type SteerRefusal = "no_active_turn" | "steering_closed";

export interface ActionRequestControl {
  /** Aborted when the player stops this request, before or during a turn. */
  readonly signal: AbortSignal;
  /**
   * Under the session lock: make this request the session's active turn.
   * Interjections not committed yet carry over from the previous turn.
   */
  beginTurn(turnId: string): TurnControl;
  /** Stop accepting interjections and hand them to the current turn's commit. */
  closeInterjections(): readonly TurnInterjection[];
  /** No further turn of this request will start. */
  finish(): void;
  /** Idempotent; removes only this request's own entries. */
  release(): void;
}

/**
 * Register an admitted action request, before it waits for anything. A stop
 * reaches it while it waits for the lock or for earlier work to settle, and
 * between the turns it chains (setup, then the opening continuation). It
 * becomes the session's active turn only under the lock, so a request queued
 * behind a running turn never takes that turn's steer/abort target.
 */
export function registerActionRequest(
  sessionId: string,
  turnId: string,
  requestId?: string,
): ActionRequestControl {
  const entry: ActionEntry = {
    turnId,
    requestId,
    startedAt: new Date().toISOString(),
    controller: new AbortController(),
    steering: [],
    accepted: [],
    read: 0,
    steeringOpen: true,
    finished: false,
  };
  const waiting = waitingRequests.get(sessionId) ?? new Set<ActionEntry>();
  waiting.add(entry);
  waitingRequests.set(sessionId, waiting);
  const leaveWaiting = () => {
    const set = waitingRequests.get(sessionId);
    if (!set?.delete(entry)) return;
    if (set.size === 0) waitingRequests.delete(sessionId);
  };
  return {
    signal: entry.controller.signal,
    beginTurn: (nextTurnId) => {
      leaveWaiting();
      entry.turnId = nextTurnId;
      entry.steeringOpen = true;
      // A newer registration replaces a stale one (a crashed stream that
      // never released).
      activeTurns.set(sessionId, entry);
      return {
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
      };
    },
    closeInterjections: () => {
      entry.steeringOpen = false;
      // The next turn reads these from committed history, not this queue.
      entry.steering.length = 0;
      entry.read = 0;
      return entry.accepted.splice(0);
    },
    finish: () => {
      entry.finished = true;
      leaveWaiting();
    },
    release: () => {
      leaveWaiting();
      if (activeTurns.get(sessionId) === entry) {
        activeTurns.delete(sessionId);
      }
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
  if (!entry || entry.finished) return { refused: "no_active_turn" };
  if (!entry.steeringOpen || entry.controller.signal.aborted) {
    return { refused: "steering_closed" };
  }
  entry.steering.push(message);
  entry.accepted.push({ content: message });
  return { turnId: entry.turnId };
}

/**
 * Stop the session's action: the request running a turn, or, when none runs,
 * the requests still waiting to start one. Null once every request's last
 * turn has ended. Idempotent.
 */
export function abortActiveTurn(sessionId: string): { turnId: string } | null {
  const active = activeTurns.get(sessionId);
  if (active && !active.finished) {
    active.controller.abort();
    return { turnId: active.turnId };
  }
  const waiting = [...(waitingRequests.get(sessionId) ?? [])];
  for (const entry of waiting) entry.controller.abort();
  const first = waiting[0];
  return first ? { turnId: first.turnId } : null;
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
