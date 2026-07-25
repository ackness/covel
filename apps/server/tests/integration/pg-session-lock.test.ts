/**
 * Integration tests for `createPgAdvisorySessionLock`.
 *
 * These tests connect to a real PostgreSQL instance and verify the
 * cross-process invariants that the in-process lock cannot cover:
 *
 *   1. Same-session `withLock` calls on the same `Sql` client serialize.
 *   2. Different-session calls on the same `Sql` client run concurrently.
 *   3. Errors thrown by `fn` release the lock so a subsequent call proceeds
 *      without waiting for the timeout.
 *   4. Two independent `Sql` clients (simulating two Node pods) serialize
 *      on the same sessionId. This is the core cross-pod guarantee the
 *      in-process lock cannot provide.
 *
 * Skipped automatically when `DATABASE_URL` is not set or the server is
 * unreachable within 2s — matches the pattern used by
 * `packages/store/tests/pg-store.test.ts` so `pnpm test` passes on dev
 * machines without PG.
 */

import { describe, it, expect } from "vitest";
import postgres from "postgres";
import {
  createPgAdvisorySessionLock,
  hashSessionId,
} from "../../src/lib/pg-session-lock.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";

// Probe once at module load so the describe.skipIf below is deterministic.
async function pgReachable(): Promise<boolean> {
  try {
    const probe = postgres(DATABASE_URL, { connect_timeout: 2, max: 1 });
    await probe`SELECT 1`;
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await pgReachable();

describe.skipIf(!pgAvailable)("pg-session-lock", () => {
  it("serializes concurrent withLock() calls on the same sessionId", async () => {
    const sql = postgres(DATABASE_URL, { max: 4 });
    const lock = createPgAdvisorySessionLock(sql);

    const sessionId = `sess-serialize-${Date.now()}`;
    const log: string[] = [];

    const a = lock.withLock(sessionId, async () => {
      log.push("A-start");
      await new Promise((r) => setTimeout(r, 100));
      log.push("A-end");
    });
    const b = lock.withLock(sessionId, async () => {
      log.push("B-start");
      log.push("B-end");
    });
    await Promise.all([a, b]);

    // One call must finish fully before the other starts. PostgreSQL advisory
    // locks do not guarantee FIFO acquisition, so either complete block may run
    // first as long as there is no interleaving.
    expect([
      ["A-start", "A-end", "B-start", "B-end"],
      ["B-start", "B-end", "A-start", "A-end"],
    ]).toContainEqual(log);

    await sql.end();
  });

  it("does NOT serialize across different sessionIds", async () => {
    // Two separate sessions must acquire their locks independently. Assert on
    // critical-section overlap instead of a fixed wall-clock ceiling so this
    // stays stable when the full test suite adds PG roundtrip overhead.
    const sql = postgres(DATABASE_URL, { max: 4 });
    const lock = createPgAdvisorySessionLock(sql);

    const s1 = `sess-a-${Date.now()}`;
    const s2 = `sess-b-${Date.now()}`;
    const spans = new Map<string, { start?: number; end?: number }>();

    const run = (id: string) =>
      lock.withLock(id, async () => {
        const span = spans.get(id) ?? {};
        span.start = performance.now();
        spans.set(id, span);
        await new Promise((r) => setTimeout(r, 100));
        span.end = performance.now();
      });

    await Promise.all([run(s1), run(s2)]);
    const a = spans.get(s1);
    const b = spans.get(s2);
    expect(a?.start).toBeDefined();
    expect(a?.end).toBeDefined();
    expect(b?.start).toBeDefined();
    expect(b?.end).toBeDefined();
    expect(Math.max(a!.start!, b!.start!)).toBeLessThan(
      Math.min(a!.end!, b!.end!),
    );

    await sql.end();
  });

  it("releases the lock on thrown error so subsequent callers proceed", async () => {
    const sql = postgres(DATABASE_URL, { max: 4 });
    const lock = createPgAdvisorySessionLock(sql);

    const sessionId = `sess-err-${Date.now()}`;

    await expect(
      lock.withLock(sessionId, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // If the lock failed to release, re-acquiring would block until the
    // 30s default timeout. A successful sub-second re-acquire proves the
    // advisory lock was released on the error path.
    const t0 = Date.now();
    await lock.withLock(sessionId, async () => {});
    expect(Date.now() - t0).toBeLessThan(500);

    await sql.end();
  });

  it("serializes across two independent Sql clients (simulating two pods)", async () => {
    // This is the core guarantee — mutual exclusion across processes.
    // Two clients, two connection pools, same DB: the advisory lock must
    // still force strict ordering on the same sessionId.
    const sqlA = postgres(DATABASE_URL, { max: 4 });
    const sqlB = postgres(DATABASE_URL, { max: 4 });
    const lockA = createPgAdvisorySessionLock(sqlA);
    const lockB = createPgAdvisorySessionLock(sqlB);

    const sessionId = `sess-cross-${Date.now()}`;
    const log: string[] = [];

    // B must not start until A demonstrably holds the lock, or the two pools
    // race to connect and whichever wins takes it first — the mutual exclusion
    // still holds, but the winner is arbitrary and the assertion below is not
    // about the winner. Gate on A's callback rather than a sleep, so the
    // head start is a fact instead of a guess about connect latency.
    let aHoldsLock!: () => void;
    const aAcquired = new Promise<void>((resolve) => {
      aHoldsLock = resolve;
    });

    const a = lockA.withLock(sessionId, async () => {
      log.push("A-start");
      aHoldsLock();
      await new Promise((r) => setTimeout(r, 100));
      log.push("A-end");
    });
    await aAcquired;
    const b = lockB.withLock(sessionId, async () => {
      log.push("B-start");
      log.push("B-end");
    });
    await Promise.all([a, b]);

    expect(log).toEqual(["A-start", "A-end", "B-start", "B-end"]);

    await Promise.all([sqlA.end(), sqlB.end()]);
  });

  it("surfaces a clear error when the acquire times out", async () => {
    const sql = postgres(DATABASE_URL, { max: 4 });
    const lock = createPgAdvisorySessionLock(sql, {
      acquireTimeoutMs: 150,
      pollIntervalMs: 20,
    });

    const sessionId = `sess-timeout-${Date.now()}`;

    // Holder keeps the lock for ~300ms, exceeding the contender's 150ms
    // acquire timeout so we can observe the timeout path deterministically.
    const holder = lock.withLock(sessionId, async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    // Brief delay so the holder reliably acquires before we race.
    await new Promise((r) => setTimeout(r, 30));

    await expect(
      lock.withLock(sessionId, async () => {
        throw new Error("should-not-reach-fn");
      }),
    ).rejects.toThrow(/failed to acquire lock for session .* within 150ms/);

    // Let the holder finish cleanly before tearing down the pool.
    await holder;
    await sql.end();
  });

  it("counts pool checkout time against the acquire deadline (R-15)", async () => {
    // Pool of 1: the holder's reserved connection exhausts it, so the
    // contender's `sql.reserve()` queues. The deadline must cover that queue
    // wait — previously the 30s clock only started after reserve() resolved.
    const sql = postgres(DATABASE_URL, { max: 1 });
    const lock = createPgAdvisorySessionLock(sql, {
      acquireTimeoutMs: 200,
      pollIntervalMs: 20,
    });

    const holder = lock.withLock(`sess-pool-hold-${Date.now()}`, async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    // Brief delay so the holder reliably reserves the only connection.
    await new Promise((r) => setTimeout(r, 50));

    const t0 = Date.now();
    await expect(
      lock.withLock(`sess-pool-wait-${Date.now()}`, async () => {
        throw new Error("should-not-reach-fn");
      }),
    ).rejects.toThrow(
      /failed to reserve a lock connection for session .* within 200ms/,
    );
    // The timeout must fire near the deadline, not after the holder releases.
    expect(Date.now() - t0).toBeLessThan(500);

    await holder;
    await sql.end();
  });
});

describe("hashSessionId", () => {
  it("is deterministic and stays within the positive bigint range", () => {
    const a1 = hashSessionId("sess-abc");
    const a2 = hashSessionId("sess-abc");
    expect(a1).toBe(a2);
    expect(a1 >= 0n).toBe(true);
    expect(a1 <= 0x7fffffffffffffffn).toBe(true);
  });

  it("produces distinct keys for distinct sessionIds", () => {
    const a = hashSessionId("sess-1");
    const b = hashSessionId("sess-2");
    expect(a).not.toBe(b);
  });
});
