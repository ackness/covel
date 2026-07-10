/**
 * In-flight turn control registry (roadmap W4) — one entry per session with
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
  readonly controller: AbortController;
  readonly steering: string[];
}

const activeTurns = new Map<string, ActiveTurnEntry>();

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
): RegisteredTurn {
  const entry: ActiveTurnEntry = {
    turnId,
    controller: new AbortController(),
    steering: [],
  };
  activeTurns.set(sessionId, entry);
  return {
    turnControl: {
      signal: entry.controller.signal,
      drainSteering: () => entry.steering.splice(0),
    },
    release: () => {
      if (activeTurns.get(sessionId) === entry) {
        activeTurns.delete(sessionId);
      }
    },
  };
}

/** Queue a player interjection into the session's active turn. */
export function steerActiveTurn(
  sessionId: string,
  message: string,
): { turnId: string } | null {
  const entry = activeTurns.get(sessionId);
  if (!entry || entry.controller.signal.aborted) return null;
  entry.steering.push(message);
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
