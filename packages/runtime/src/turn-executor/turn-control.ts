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
   * Internal execution cancellation. Parent runtime deadlines use this signal
   * to stop nested work without masquerading as a player-requested abort.
   */
  readonly executionSignal?: AbortSignal;
  /**
   * Drain queued player interjections. Story-output runtimes call this
   * before each LLM step and merge the messages into the live transcript;
   * plugin runtimes never see steering.
   */
  readonly drainSteering?: () => readonly string[];
}

export function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) return second;
  if (!second || first === second) return first;
  return AbortSignal.any([first, second]);
}

/** Signal that all in-flight execution work must observe. */
export function getTurnExecutionSignal(
  control: TurnControl | undefined,
): AbortSignal | undefined {
  return combineAbortSignals(control?.signal, control?.executionSignal);
}

/** True for either a player abort or an internal parent/deadline abort. */
export function isTurnExecutionAborted(
  control: TurnControl | undefined,
): boolean {
  return (
    control?.signal?.aborted === true ||
    control?.executionSignal?.aborted === true
  );
}

/** Preserve the public player-abort error while surfacing internal reasons. */
export function throwIfTurnExecutionAborted(
  control: TurnControl | undefined,
  context: string,
): void {
  if (control?.signal?.aborted) {
    throw new TurnAbortedError(`turn aborted by player during ${context}`);
  }
  if (control?.executionSignal?.aborted) {
    const reason = control.executionSignal.reason;
    throw reason instanceof Error
      ? reason
      : new Error(`turn execution aborted during ${context}`);
  }
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
