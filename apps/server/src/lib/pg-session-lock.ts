/**
 * PostgreSQL advisory-lock-based session lock.
 *
 * Correct across multiple Node processes / pods pointing at the same PG
 * instance — `pg_advisory_lock` is a cluster-wide mutex keyed by bigint.
 *
 * ## Why this exists
 *
 * The in-process `Map<sessionId, Promise>` lock in `session-lock.ts` only
 * protects same-session requests inside one Node process. Covel's documented
 * multi-instance production topology (one PG backend + N app pods) needs
 * mutual exclusion that the load balancer sees. This module provides that.
 *
 * ## Invariants
 *
 * 1. **Same connection for acquire + release.** PG advisory locks are tied
 *    to the PG session (= backend process). We therefore `sql.reserve()` a
 *    dedicated postgres.js connection for the whole duration of `fn`, then
 *    release it back to the pool after unlocking.
 * 2. **Never leak reserved connections.** Both happy and error paths run
 *    `reserved.release()` in `finally`. If the connection drops (pod crash,
 *    network partition, PG restart) the advisory lock is auto-released by
 *    PG — that is the recovery path, not a bug.
 * 3. **Never deadlock on a stuck predecessor.** We use `pg_try_advisory_lock`
 *    in a bounded polling loop; after `acquireTimeoutMs` we give up and
 *    throw, rather than waiting forever on a pod that died mid-turn.
 * 4. **Hash space is 2^63.** We SHA-256 the sessionId and read the first 8
 *    bytes as signed int64, then mask to the positive range. Collision
 *    probability on realistic session counts is effectively zero, and
 *    staying in the positive range avoids driver-level surprises around
 *    negative bigints.
 *
 * Operational notes
 *   - Each in-flight turn holds one reserved connection. Size the postgres
 *     client pool (`max`) at least at peak expected concurrent sessions.
 *   - If you ever see the timeout message in logs, one of: (a) a turn is
 *     taking > timeout; (b) a pod crashed without closing its PG connection
 *     cleanly (PG will reap it eventually); (c) a real deadlock upstream.
 *     The error message includes the sessionId so you can correlate with
 *     the stuck turn trace.
 */

import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Sql } from "postgres";
import {
  createInProcessSessionLock,
  SessionLockTimeoutError,
  type SessionLock,
  type TrySessionLockResult,
} from "./session-lock.js";

interface PgLockState {
  readonly reserved: ReservedConnection;
  readonly localNestedLock: SessionLock;
  active: boolean;
  nestedCount: number;
  nestedIdle: Promise<void>;
  resolveNestedIdle?: () => void;
}

interface PgLockBranch {
  readonly state: PgLockState;
  readonly heldKeys: ReadonlySet<string>;
}

export interface PgAdvisorySessionLockOptions {
  /**
   * Maximum total time to wait for the lock — covering BOTH the pool
   * checkout (`sql.reserve()`, which queues when the pool is exhausted) and
   * the advisory-lock polling loop. Default 30_000ms — comfortably above a
   * normal turn, deliberately below HTTP request timeouts so a stuck lock
   * surfaces as a proper API error rather than a silent hang.
   */
  readonly acquireTimeoutMs?: number;
  /**
   * Poll interval when `pg_try_advisory_lock` returns false. Default 50ms.
   * Lower values shave latency at high contention; higher values reduce
   * query rate. 50ms is a reasonable middle ground.
   */
  readonly pollIntervalMs?: number;
}

/**
 * Create a PG advisory-lock-backed {@link SessionLock}.
 *
 * The returned lock holds one reserved postgres.js connection per in-flight
 * `withLock` call. Callers MUST size their postgres.js pool (`max` option)
 * at least as large as the expected peak number of concurrent sessions per
 * pod; an undersized pool will queue `sql.reserve()` calls and artificially
 * serialize unrelated sessions.
 */
export function createPgAdvisorySessionLock(
  sql: Sql,
  opts: PgAdvisorySessionLockOptions = {},
): SessionLock {
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 30_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 50;
  const lockContext = new AsyncLocalStorage<PgLockBranch>();

  const beginNested = (state: PgLockState): void => {
    if (state.nestedCount === 0) {
      state.nestedIdle = new Promise<void>((resolve) => {
        state.resolveNestedIdle = resolve;
      });
    }
    state.nestedCount += 1;
  };

  const endNested = (state: PgLockState): void => {
    state.nestedCount -= 1;
    if (state.nestedCount === 0) {
      state.resolveNestedIdle?.();
      state.resolveNestedIdle = undefined;
    }
  };

  const unlockEntries = async (
    reserved: ReservedConnection,
    entries: readonly { readonly id: string; readonly keyLiteral: string }[],
  ): Promise<void> => {
    for (const entry of [...entries].reverse()) {
      try {
        await reserved`SELECT pg_advisory_unlock(${entry.keyLiteral}::bigint)`;
      } catch (err) {
        // PG auto-releases on connection close. Do not mask the original fn
        // error with a secondary unlock failure.
        console.warn(
          `[pg-session-lock] unlock failed for session ${entry.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  };

  const withLocks = async <T>(
    lockIds: readonly string[],
    fn: () => Promise<T>,
  ): Promise<T> => {
    const orderedIds = [...new Set(lockIds)];
    if (orderedIds.length === 0) return fn();
    // postgres.js's `Serializable` type does not include `bigint`, even
    // though the driver serialises bigint parameters correctly at
    // runtime. Passing the key as a decimal string with an explicit
    // `::bigint` cast is the safest TypeScript-clean way to keep the
    // full 2^63 key space without losing precision through a `number`
    // (which maxes out at 2^53).
    const keyed = orderedIds.map((id) => ({
      id,
      keyLiteral: hashSessionId(id).toString(),
    }));

    // Nested runtime -> session locking must reuse the connection already
    // reserved by the outer runtime lock. Reserving again deadlocks at pool
    // max=1 and can exhaust any finite pool under enough concurrent jobs.
    const parent = lockContext.getStore();
    if (parent?.state.active) {
      const newlyLocked = keyed.filter(
        (entry) => !parent.heldKeys.has(entry.keyLiteral),
      );
      if (newlyLocked.length === 0) return fn();
      beginNested(parent.state);
      try {
        return await parent.state.localNestedLock.withLocks(
          newlyLocked.map((entry) => entry.keyLiteral),
          async () => {
            const acquired: typeof newlyLocked = [];
            const nestedDeadlineAt = Date.now() + acquireTimeoutMs;
            try {
              for (const entry of newlyLocked) {
                await acquireWithTimeout(
                  parent.state.reserved,
                  entry.keyLiteral,
                  nestedDeadlineAt,
                  acquireTimeoutMs,
                  pollIntervalMs,
                  entry.id,
                );
                acquired.push(entry);
              }
              return await lockContext.run(
                {
                  state: parent.state,
                  heldKeys: new Set([
                    ...parent.heldKeys,
                    ...acquired.map((entry) => entry.keyLiteral),
                  ]),
                },
                fn,
              );
            } finally {
              await unlockEntries(parent.state.reserved, acquired);
            }
          },
        );
      } finally {
        endNested(parent.state);
      }
    }

    // Single deadline covering BOTH pool checkout and the advisory-lock
    // polling loop. `sql.reserve()` queues unboundedly when the pool is
    // exhausted; starting the clock only after it resolved (the previous
    // behaviour) let pool exhaustion hide behind an unbounded wait.
    const deadlineAt = Date.now() + acquireTimeoutMs;

    // `sql.reserve()` checks out a dedicated connection. The same handle
    // MUST be used for both the acquire and the release — advisory locks
    // are session-scoped (PG session, not Covel session).
    const reserved = await reserveWithDeadline(
      sql,
      deadlineAt,
      acquireTimeoutMs,
      orderedIds.join(","),
    );
    const locked: Array<{ readonly id: string; readonly keyLiteral: string }> =
      [];
    const state: PgLockState = {
      reserved,
      localNestedLock: createInProcessSessionLock(),
      active: true,
      nestedCount: 0,
      nestedIdle: Promise.resolve(),
    };
    try {
      for (const entry of keyed) {
        await acquireWithTimeout(
          reserved,
          entry.keyLiteral,
          deadlineAt,
          acquireTimeoutMs,
          pollIntervalMs,
          entry.id,
        );
        locked.push(entry);
      }
      return await lockContext.run(
        {
          state,
          heldKeys: new Set(locked.map((entry) => entry.keyLiteral)),
        },
        fn,
      );
    } finally {
      await state.nestedIdle;
      state.active = false;
      await unlockEntries(reserved, locked);
      // Always return the connection to the pool, even on failed acquires.
      reserved.release();
    }
  };

  const probeReserved = async <T>(
    state: PgLockState,
    entry: { id: string; keyLiteral: string },
    heldKeys: ReadonlySet<string>,
    fn: () => Promise<T>,
    waitForNested = false,
  ): Promise<TrySessionLockResult<T>> => {
    const rows = await state.reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${entry.keyLiteral}::bigint) AS locked
    `;
    if (!rows[0]?.locked) return { acquired: false };
    try {
      return {
        acquired: true,
        value: await lockContext.run(
          { state, heldKeys: new Set([...heldKeys, entry.keyLiteral]) },
          fn,
        ),
      };
    } finally {
      if (waitForNested) await state.nestedIdle;
      await unlockEntries(state.reserved, [entry]);
    }
  };

  const tryWithLock = async <T>(
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<TrySessionLockResult<T>> => {
    const entry = {
      id: sessionId,
      keyLiteral: hashSessionId(sessionId).toString(),
    };
    const parent = lockContext.getStore();
    if (parent?.state.active) {
      if (parent.heldKeys.has(entry.keyLiteral)) {
        return { acquired: true, value: await fn() };
      }
      // PG considers the same connection reentrant. Sibling async branches
      // still need local exclusion before probing an additional key on it.
      beginNested(parent.state);
      try {
        const nested = await parent.state.localNestedLock.tryWithLock!(
          entry.keyLiteral,
          () => probeReserved(parent.state, entry, parent.heldKeys, fn),
        );
        return nested.acquired ? nested.value : { acquired: false };
      } finally {
        endNested(parent.state);
      }
    }

    let reserved: ReservedConnection;
    try {
      // A status probe must not queue behind turns exhausting the lock pool.
      // Late checkouts are released by reserveWithDeadline without running fn.
      reserved = await reserveWithDeadline(sql, Date.now(), 0, sessionId);
    } catch (error) {
      if (error instanceof SessionLockTimeoutError) return { acquired: false };
      throw error;
    }
    const state: PgLockState = {
      reserved,
      localNestedLock: createInProcessSessionLock(),
      active: true,
      nestedCount: 0,
      nestedIdle: Promise.resolve(),
    };
    try {
      return await probeReserved(state, entry, new Set(), fn, true);
    } finally {
      state.active = false;
      reserved.release();
    }
  };

  return {
    withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
      return withLocks([sessionId], fn);
    },
    withLocks,
    tryWithLock,
  };
}

/**
 * Map a sessionId to a PG advisory-lock bigint key.
 *
 * PG advisory locks take either a single `bigint` or two `int4`s; we use the
 * `bigint` form. Reading the first 8 bytes of SHA-256 as signed int64 and
 * masking to the positive range gives a 2^63 key space with essentially zero
 * collision risk at realistic session counts.
 */
export function hashSessionId(sessionId: string): bigint {
  const h = createHash("sha256").update(sessionId).digest();
  const raw = h.readBigInt64BE(0);
  // 0x7FFF... = 2^63 - 1. Clearing the sign bit avoids negative-bigint edge
  // cases in the pg driver and keeps the key within documented PG ranges.
  return raw & 0x7fffffffffffffffn;
}

type ReservedConnection = Awaited<ReturnType<Sql["reserve"]>>;

/**
 * Check out a dedicated connection, bounded by the caller's absolute
 * deadline. Without the bound, an exhausted pool queues `reserve()` calls
 * indefinitely and the lock timeout never starts counting. If the queued
 * reserve resolves after we already gave up, the connection is returned to
 * the pool instead of leaking.
 */
async function reserveWithDeadline(
  sql: Sql,
  deadlineAt: number,
  totalTimeoutMs: number,
  sessionId: string,
): Promise<ReservedConnection> {
  const reservePromise = sql.reserve();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new SessionLockTimeoutError(
            `[pg-session-lock] failed to reserve a lock connection for session ${sessionId} within ${totalTimeoutMs}ms (lock pool exhausted?)`,
          ),
        ),
      Math.max(0, deadlineAt - Date.now()),
    );
  });
  try {
    return await Promise.race([reservePromise, timeout]);
  } catch (err) {
    // Late-resolving reserve after a timeout: release back to the pool.
    void reservePromise.then((r) => r.release()).catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function acquireWithTimeout(
  reserved: ReservedConnection,
  keyLiteral: string,
  deadlineAt: number,
  totalTimeoutMs: number,
  pollIntervalMs: number,
  sessionId: string,
): Promise<void> {
  // Poll `pg_try_advisory_lock` instead of blocking on `pg_advisory_lock`.
  // Non-blocking acquires keep the reserved connection interruptible and
  // let us enforce a bounded timeout without spawning a cancel goroutine.
  // `deadlineAt` is shared with the reserve step, so reserve + acquire
  // together never exceed the configured acquire timeout.
  while (true) {
    const rows = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${keyLiteral}::bigint) AS locked
    `;
    if (rows[0]?.locked) return;
    if (Date.now() > deadlineAt) {
      throw new SessionLockTimeoutError(
        `[pg-session-lock] failed to acquire lock for session ${sessionId} within ${totalTimeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
