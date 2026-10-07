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
  readonly steering: string[];
  /** False once no runtime of the execution reads the queue any more. */
  steeringOpen: boolean;
}

const activeTurns = new Map<string, ActiveTurnEntry>();

/** Why an interjection was not queued; also the code of the 409 response. */
export type SteerRefusal = "no_active_turn" | "steering_closed";

export interface RegisteredTurn {
  readonly turnControl: TurnControl;
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
    steeringOpen: true,
  };
  activeTurns.set(sessionId, entry);
  return {
    turnControl: {
      signal: entry.controller.signal,
      drainSteering: () => entry.steering.splice(0),
      closeSteering: () => {
        entry.steeringOpen = false;
      },
    },
    release: () => {
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
