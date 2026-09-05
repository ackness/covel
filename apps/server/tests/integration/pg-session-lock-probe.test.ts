import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createPgAdvisorySessionLock } from "../../src/lib/pg-session-lock.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";
async function reachable() {
  const sql = postgres(databaseUrl, { connect_timeout: 2, max: 1 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch (cause) {
    if (process.env.COVEL_REQUIRE_PG_TESTS === "1")
      throw new Error("PostgreSQL is required for session lock tests", {
        cause,
      });
    return false;
  } finally {
    await sql.end();
  }
}

const available = await reachable();

describe.skipIf(!available)("PostgreSQL nonblocking lock integration", () => {
  it("observes another pod's owner without waiting and acquires after release", async () => {
    const sqlA = postgres(databaseUrl, { max: 1 });
    const sqlB = postgres(databaseUrl, { max: 1 });
    const a = createPgAdvisorySessionLock(sqlA);
    const b = createPgAdvisorySessionLock(sqlB);
    const sessionId = `probe-cross-${crypto.randomUUID()}`;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const owner = a.withLock(sessionId, async () => {
      entered();
      await gate;
    });
    try {
      await started;
      const warm = await sqlB.reserve();
      warm.release();
      expect(await b.tryWithLock!(sessionId, async () => 42)).toEqual({
        acquired: false,
      });
      release();
      await owner;
      expect(await b.tryWithLock!(sessionId, async () => 42)).toEqual({
        acquired: true,
        value: 42,
      });
    } finally {
      release();
      await owner;
      await Promise.all([sqlA.end(), sqlB.end()]);
    }
  });

  it("reenters an owner at pool size one and releases callback failures", async () => {
    const sql = postgres(databaseUrl, { max: 1 });
    const lock = createPgAdvisorySessionLock(sql);
    const sessionId = `probe-reentrant-${crypto.randomUUID()}`;
    try {
      await lock.withLock(sessionId, async () => {
        expect(await lock.tryWithLock!(sessionId, async () => 42)).toEqual({
          acquired: true,
          value: 42,
        });
        expect(
          await lock.tryWithLock!(`${sessionId}-inner`, async () => 43),
        ).toEqual({ acquired: true, value: 43 });
      });
      await expect(
        lock.tryWithLock!(sessionId, async () => {
          throw new Error("probe failed");
        }),
      ).rejects.toThrow("probe failed");
      expect(
        await lock.tryWithLock!(sessionId, async () => "recovered"),
      ).toEqual({ acquired: true, value: "recovered" });
    } finally {
      await sql.end();
    }
  });

  it("reports an exhausted pool without waiting for its current lease", async () => {
    const sql = postgres(databaseUrl, { max: 1 });
    const lock = createPgAdvisorySessionLock(sql);
    const occupied = await sql.reserve();
    try {
      expect(
        await lock.tryWithLock!(
          `probe-pool-${crypto.randomUUID()}`,
          async () => "unexpected",
        ),
      ).toEqual({ acquired: false });
    } finally {
      occupied.release();
      // Let the timed-out checkout resolve and return its connection before
      // shutting down the pool; this query also proves no checkout leaked.
      await sql`SELECT 1`;
      await sql.end();
    }
  });
});
