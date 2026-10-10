import type { EventBus } from "@covel/events";
import type { TurnEmitter } from "../trace/turn-emitter.js";

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Run the buffered post-commit work of a transaction that has committed. The
 * data is stored, so a failing thunk cannot undo the commit; the clients that
 * were meant to hear about it are told to read the stored state instead. Every
 * thunk runs even when an earlier one failed. Returns whether any failed.
 */
export async function flushPostCommit(
  thunks: readonly (() => Promise<void>)[],
  ctx: {
    readonly sessionId: string;
    readonly label: string;
    readonly eventBus?: EventBus;
    readonly emitter?: TurnEmitter;
  },
): Promise<boolean> {
  const errors: string[] = [];
  for (const fn of thunks) {
    try {
      await fn();
    } catch (err) {
      errors.push(errorMessage(err));
      console.warn(
        `[${ctx.label}] post-commit fan-out failed for session ${ctx.sessionId}:`,
        errorMessage(err),
      );
    }
  }
  if (errors.length === 0) return false;
  try {
    await ctx.emitter?.emit("commit.fanout.failed", {
      failedCount: errors.length,
      totalCount: thunks.length,
      errors: errors.slice(0, 5),
    });
  } catch {
    // The trace is a diagnostic; the reset below is what clients depend on.
  }
  ctx.eventBus?.invalidateReplay?.(ctx.sessionId, "publish-failed");
  return true;
}
