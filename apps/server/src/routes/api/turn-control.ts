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
  /** False once no runtime of the execution reads the queue any more. */
  steeringOpen: boolean;
  /** No further turn of the request will start: a stop has nothing to stop. */
  finished: boolean;
}

/** The request holding (or last holding) each session's execution lock. */
const activeTurns = new Map<string, ActionEntry>();
/** Admitted requests that have not taken the execution lock yet. */
const waitingRequests = new Map<string, Set<ActionEntry>>();

/** Why an interjection was not queued; also the code of the 409 response. */
export type SteerRefusal = "no_active_turn" | "steering_closed";

export interface RegisteredTurn {
  readonly turnControl: TurnControl;
  readonly release: () => void;
}

export interface ActionRequestControl {
  /** Aborted when the player stops this request, before or during a turn. */
  readonly signal: AbortSignal;
  /**
   * Under the session lock: make this request the session's active turn.
   * Interjections not read yet carry over from the request's previous turn.
   */
  beginTurn(turnId: string): TurnControl;
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
        drainSteering: () => entry.steering.splice(0),
        closeSteering: () => {
          entry.steeringOpen = false;
        },
      };
    },
    finish: () => {
      entry.finished = true;
      leaveWaiting();
    },
    release: () => {
      leaveWaiting();
      if (activeTurns.get(sessionId) === entry) {
        if (entry.steering.length > 0) {
          // Accepted while a story runtime could still read the queue, which
          // then ended without another step. The chat log has them; the
          // prompt history of later turns comes from the turn journal, which
          // does not.
          console.warn(
            `[turn-control] ${sessionId}: ${entry.steering.length} steering message(s) were accepted for turn ${entry.turnId} but no story runtime read them; they are in the chat log only, not in the prompt history of later turns`,
          );
        }
        activeTurns.delete(sessionId);
      }
    },
  };
}

/** A request whose turn starts at once; for callers outside the actions route. */
export function registerActiveTurn(
  sessionId: string,
  turnId: string,
  requestId?: string,
): RegisteredTurn {
  const request = registerActionRequest(sessionId, turnId, requestId);
  return { turnControl: request.beginTurn(turnId), release: request.release };
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
  return { turnId: entry.turnId };
}

/**
 * Best-effort removal of a queued interjection whose persistence failed —
 * no-op when the loop already drained it (the retry may then duplicate,
 * but the common case is retracted before the next LLM step).
 */
export function retractSteering(sessionId: string, message: string): void {
  const entry = activeTurns.get(sessionId);
  if (!entry) return;
  const idx = entry.steering.lastIndexOf(message);
  if (idx >= 0) entry.steering.splice(idx, 1);
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
