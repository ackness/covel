/**
 * In-process per-session serializer.
 *
 * `withSessionLock(sessionId, fn)` ensures that at most one `fn` runs at a
 * time for a given sessionId. Subsequent callers queue behind the previous
 * chain tail and wait their turn.
 *
 * Scope: the lock is process-local. For multi-process deployments (one PG
 * backend, N app pods) this must be upgraded to a PG advisory lock
 * (`pg_try_advisory_lock(hashtext(sessionId))`) or a Redis-based lock.
 *
 * Rationale (audit 2026-04-20, finding 1): without this, two concurrent
 * `/api/actions` requests to the same session read the same
 * `listTurnResults().length`, compute the same turnNumber, and interleave
 * state patches / auto-snapshots. The UI's `executing` flag is client-side
 * only and cannot protect non-browser callers.
 *
 * The lock is *serialization only*; exceptions thrown by `fn` propagate to
 * the caller and do not poison the chain — the slot releases regardless.
 */

type ChainTail = Promise<unknown>;

const locks = new Map<string, ChainTail>();

export async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previousTail: ChainTail = locks.get(sessionId) ?? Promise.resolve();

  let release: () => void = () => {};
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Chain this slot *after* the previous tail — use `.catch` to make the
  // chain never reject so a failing predecessor cannot poison successors.
  const chain: ChainTail = previousTail.then(() => slot, () => slot);
  locks.set(sessionId, chain);

  try {
    // Wait for our predecessor to finish (swallow their errors — they are
    // already propagated to their own caller, we just need ordering).
    await previousTail.catch(() => { /* isolate */ });
    return await fn();
  } finally {
    release();
    // If no one queued behind us, drop the map entry to prevent unbounded
    // growth on cold sessions. Guard against racing inserts.
    if (locks.get(sessionId) === chain) {
      locks.delete(sessionId);
    }
  }
}

/** Test-only: observe current lock count. */
export function _lockCountForTests(): number {
  return locks.size;
}
