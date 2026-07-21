/**
 * Player turn-control surface — mid-turn steering and abort.
 *
 * The server registers one `TurnControl` per in-flight turn and threads it
 * through `AgentLoopDeps`. Leaf module (only depends on @covel/shared) so the
 * retry layer, the agent loop, and the turn executor can all depend on it
 * without cycles.
 */

/** Abort reason surfaced on `TurnResult.abortReason` for player aborts.
 *  Defined in @covel/shared (wire-protocol constant — the web client keys
 *  its abort terminal state on it); re-exported here for runtime callers. */
export { PLAYER_ABORT_REASON } from "@covel/shared";

export interface TurnControl {
  /**
   * Fired when the player aborts the turn. Cuts the in-flight LLM call /
   * stream immediately (threaded into the retry layer's per-attempt signal;
   * bypasses the partial-content salvage path so no partial narrative is
   * ever committed) and stops scheduling further runtimes.
   */
  readonly signal?: AbortSignal;
  /**
   * Drain queued player interjections. Story-output runtimes call this
   * before each LLM step and merge the messages into the live transcript;
   * plugin runtimes never see steering.
   */
  readonly drainSteering?: () => readonly string[];
}

/** Thrown when a player abort interrupts an LLM call or the agent loop. */
export class TurnAbortedError extends Error {
  readonly code = "TURN_ABORTED" as const;
  constructor(message = "turn aborted by player") {
    super(message);
    this.name = "TurnAbortedError";
  }
}

export function isTurnAbortedError(err: unknown): err is TurnAbortedError {
  return (
    err instanceof TurnAbortedError ||
    (err instanceof Error &&
      (err as { code?: unknown }).code === "TURN_ABORTED")
  );
}
