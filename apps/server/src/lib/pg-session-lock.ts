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
import type { Sql } from "postgres";
import { SessionLockTimeoutError, type SessionLock } from "./session-lock.js";

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

  return {
    async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
      // postgres.js's `Serializable` type does not include `bigint`, even
      // though the driver serialises bigint parameters correctly at
      // runtime. Passing the key as a decimal string with an explicit
      // `::bigint` cast is the safest TypeScript-clean way to keep the
      // full 2^63 key space without losing precision through a `number`
      // (which maxes out at 2^53).
      const keyLiteral = hashSessionId(sessionId).toString();

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
        sessionId,
      );
      let locked = false;
      try {
        await acquireWithTimeout(
          reserved,
          keyLiteral,
          deadlineAt,
          acquireTimeoutMs,
          pollIntervalMs,
          sessionId,
        );
        locked = true;
        return await fn();
      } finally {
        if (locked) {
          try {
            await reserved`SELECT pg_advisory_unlock(${keyLiteral}::bigint)`;
          } catch (err) {
            // Log but do not rethrow. PG auto-releases on connection close,
            // and masking the original `fn` error (if any) with an unlock
            // failure would be misleading.
            // eslint-disable-next-line no-console
            console.warn(
              `[pg-session-lock] unlock failed for session ${sessionId}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        // Always return the connection to the pool, even on failed acquires.
        reserved.release();
      }
    },
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
