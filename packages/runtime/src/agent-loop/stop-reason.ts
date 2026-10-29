/**
 * Stop reasons for thrown exits of the agent loop.
 *
 * A thrown exit keeps its error object, so `instanceof RuntimeTimeoutError`
 * and provider classification still work downstream. The reason rides beside
 * it in a WeakMap: the call site that knows the cause tags the error, the
 * loop's outer catch classifies aborts and deadlines, and finalization reads
 * the tag from the cause it is given.
 */

import type { LoopStop, StopReason } from "@covel/shared";
import {
  RuntimeTimeoutError,
  TurnAbortedError,
  type TurnControl,
} from "../turn-executor/turn-control.js";

const stops = new WeakMap<object, LoopStop>();

/** Attach `stop` to a thrown value; primitives cannot carry a tag. */
export function tagStop(error: unknown, stop: LoopStop): void {
  if (typeof error === "object" && error !== null) stops.set(error, stop);
}

/** The stop a thrown value was tagged with, if any. */
export function stopOf(error: unknown): LoopStop | undefined {
  return typeof error === "object" && error !== null
    ? stops.get(error)
    : undefined;
}

/**
 * Run `fn` and tag whatever it throws with `reason`, unless something more
 * specific already tagged it. An abort or deadline thrown through the call is
 * classified again by the loop's outer catch, which wins over this tag.
 */
export async function tagging<T>(
  reason: StopReason,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!stopOf(error)) tagStop(error, { reason });
    throw error;
  }
}

/** Synchronous form of {@link tagging}. */
export function taggingSync<T>(reason: StopReason, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (!stopOf(error)) tagStop(error, { reason });
    throw error;
  }
}

/** What the loop's outer catch needs to know about its own budget. */
export interface LoopBudgetView {
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
  expired(): boolean;
}

/**
 * Classify an error that left the loop. Aborts come first: the player's
 * stop, then the loop's own timer, then a parent's abort or timeout. Any
 * other error keeps the tag its call site gave it, or none.
 */
export function classifyLoopError(
  error: unknown,
  budget: LoopBudgetView,
  control: TurnControl | undefined,
): LoopStop | undefined {
  if (control?.signal?.aborted || error instanceof TurnAbortedError)
    return { reason: "cancelled", cancelledBy: "player" };
  // `assertLive` in the outer catch expires a budget whose clock has passed
  // the deadline, so the thrown error then is the loop's own timeout.
  if (budget.expired() || Date.now() >= budget.deadline)
    return { reason: "deadline" };
  if (budget.signal?.aborted || error instanceof RuntimeTimeoutError)
    return { reason: "cancelled", cancelledBy: "parent" };
  return stopOf(error);
}
