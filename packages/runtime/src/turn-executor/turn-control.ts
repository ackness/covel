/**
 * Player turn-control surface — mid-turn steering and abort.
 *
 * The server registers one `TurnControl` per in-flight turn and threads it
 * through `AgentLoopDeps`. Leaf module (only depends on @covel/shared) so the
 * retry layer, the agent loop, and the turn executor can all depend on it
 * without cycles.
 */

import type { RuntimeManifest } from "@covel/shared";

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
  /**
   * Stop accepting player interjections. The turn executor calls this once
   * no runtime left in the execution reads the queue, so the queue's owner
   * can refuse a late interjection instead of accepting text that no model
   * call will see.
   */
  readonly closeSteering?: () => void;
}

/**
 * Whether a runtime reads the steering queue. Only an agent with story output
 * merges interjections into its transcript: a plugin agent runs a structured
 * task that an interjection would corrupt, and a function runtime calls no
 * model.
 */
export function runtimeAcceptsSteering(
  manifest: Pick<RuntimeManifest, "outputKind" | "runtimeType">,
): boolean {
  return manifest.outputKind === "story" && manifest.runtimeType !== "function";
}

/** The runtimes of one execution that can still read the steering queue. */
export interface SteeringReaders {
  /** The runtime finished, failed or was skipped: it reads nothing further. */
  settled(runtimeId: string): void;
  /** Nothing else of the execution runs. */
  close(): void;
}

/**
 * Close the steering queue as soon as no runtime of the execution can read it.
 * `scheduled` holds the runtimes the execution runs in its foreground.
 * `eventFollowers` holds the runtimes an event fan-out may still start: a
 * reader among them keeps the queue open until the caller calls `close()`.
 */
export function trackSteeringReaders(args: {
  readonly control: TurnControl | undefined;
  readonly scheduled: readonly RuntimeManifest[];
  readonly eventFollowers: readonly RuntimeManifest[];
}): SteeringReaders {
  const pending = new Set(
    args.scheduled
      .filter(runtimeAcceptsSteering)
      .map((manifest) => manifest.name),
  );
  let awaitingFanOut = args.eventFollowers.some(runtimeAcceptsSteering);
  let closed = false;
  const closeWhenUnread = (): void => {
    if (closed || pending.size > 0 || awaitingFanOut) return;
    closed = true;
    args.control?.closeSteering?.();
  };
  closeWhenUnread();
  return {
    settled(runtimeId) {
      pending.delete(runtimeId);
      closeWhenUnread();
    },
    close() {
      pending.clear();
      awaitingFanOut = false;
      closeWhenUnread();
    },
  };
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

/** An expired execution may be observed by hooks, but cannot be recovered into success. */
export class RuntimeTimeoutError extends Error {
  override name = "RuntimeTimeoutError";
}

export function isTurnAbortedError(err: unknown): err is TurnAbortedError {
  return (
    err instanceof TurnAbortedError ||
    (err instanceof Error &&
      (err as { code?: unknown }).code === "TURN_ABORTED")
  );
}
