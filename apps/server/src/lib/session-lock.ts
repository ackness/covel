/**
 * Per-session serializer — pluggable across store backends.
 *
 * `SessionLock.withLock(sessionId, fn)` guarantees at most one `fn` runs at
 * a time for a given sessionId. Two implementations ship:
 *
 *   - {@link createInProcessSessionLock} — `Map<sessionId, Promise>` chain.
 *     Correct for single-process deployments (Memory / SQLite). Zero-cost,
 *     no external dependency.
 *   - {@link createPgAdvisorySessionLock} (see `./pg-session-lock.ts`) — uses
 *     `pg_advisory_lock` on a dedicated PG connection. Correct across
 *     multiple Node pods pointing at the same PostgreSQL instance.
 *
 * `bootstrapApi()` picks the backend-appropriate lock at composition time
 * so route handlers only depend on the `SessionLock` interface.
 *
 * Rationale
 *   - Audit 2026-04-20 finding 1: without serialization, two concurrent
 *     `/api/actions` requests to the same session read the same
 *     `listTurnResults().length`, compute the same turnNumber, and
 *     interleave state patches / auto-snapshots.
 *   - The previous `Map`-based lock was process-local,
 *     invisible across pods. Multi-instance PG deployments (the documented
 *     production topology) had no cross-pod mutual exclusion.
 *
 * Contract
 *   - `fn` exceptions propagate to the caller; the slot releases regardless.
 *   - Same-session calls are strictly serialized. Different-session calls
 *     run concurrently.
 *   - Implementations MUST release the lock on both success and failure
 *     paths, including if the acquire itself times out.
 */

/**
 * Thrown by lock implementations with a bounded acquire (PG advisory lock)
 * when the session stays busy past the acquire timeout. Routes translate it
 * into a coded 503 instead of a generic 500. The in-process lock never
 * throws this — it waits indefinitely.
 */
export class SessionLockTimeoutError extends Error {}

export interface SessionLock {
  /**
   * Acquire the lock for `sessionId`, run `fn`, release. Blocks until the
   * lock is available. If `fn` throws, the lock is still released and the
   * error propagates.
   */
  withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
}

type ChainTail = Promise<unknown>;

/**
 * Build an in-process session lock. Correct for single-node deployments.
 *
 * Each session has a tail Promise. New callers chain `await previousTail`
 * before running `fn`, then publish a new tail representing their own slot.
 * On completion the slot resolves, freeing the next waiter. The map entry
 * is GC'd when no successor has queued.
 *
 * The chain never *rejects* — predecessor failures are swallowed inside the
 * chain (their error is already delivered to their own caller) so one bad
 * turn cannot poison every subsequent turn on the session.
 */
export function createInProcessSessionLock(): SessionLock & {
  /** Test-only: observe current lock count. */
  readonly _sizeForTests: () => number;
} {
  const locks = new Map<string, ChainTail>();

  return {
    async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
      const previousTail: ChainTail = locks.get(sessionId) ?? Promise.resolve();

      let release: () => void = () => {};
      const slot = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Chain this slot *after* the previous tail — use the rejected-branch
      // handler to make the chain never reject so a failing predecessor
      // cannot poison successors.
      const chain: ChainTail = previousTail.then(
        () => slot,
        () => slot,
      );
      locks.set(sessionId, chain);

      try {
        // Wait for our predecessor to finish (swallow their errors — they
        // are already propagated to their own caller, we just need ordering).
        await previousTail.catch(() => {
          /* isolate */
        });
        return await fn();
      } finally {
        release();
        // If no one queued behind us, drop the map entry to prevent
        // unbounded growth on cold sessions. Guard against racing inserts.
        if (locks.get(sessionId) === chain) {
          locks.delete(sessionId);
        }
      }
    },
    _sizeForTests: () => locks.size,
  };
}
