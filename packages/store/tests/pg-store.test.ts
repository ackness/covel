import { runStoreContractTests } from "../src/contract/store-contract.js";
import { afterAll, describe, it, expect } from "vitest";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";
const REQUIRE_PG = process.env.COVEL_REQUIRE_PG_TESTS === "1";

// Check if PG is available before running the suite
let pgAvailable = false;
try {
  const { default: postgres } = await import("postgres");
  const client = postgres(DATABASE_URL, { connect_timeout: 3 });
  await client`SELECT 1`;
  await client.end();
  pgAvailable = true;
} catch (error) {
  if (REQUIRE_PG) {
    throw new Error("PostgreSQL is required for PgStore tests", {
      cause: error,
    });
  }
  console.warn("PostgreSQL not available, skipping PgStore tests");
}

if (pgAvailable) {
  const { createPgStore } = await import("../src/postgres/pg-store.js");
  const { createIsolatedPgDatabase } = await import("./pg-test-db.js");
  // Own database so this file never races concurrent PG test files on schema DDL.
  const isolated = await createIsolatedPgDatabase(
    DATABASE_URL,
    "covel_test_pgstore",
  );
  afterAll(() => isolated.cleanup());

  runStoreContractTests("PgStore", async () => {
    const store = await createPgStore(isolated.url, { freshSchema: true });
    return store;
  });
  it("allocates distinct log positions across simultaneous PostgreSQL clients", async () => {
    const { default: postgres } = await import("postgres");
    const { makeSession, makeMessage, makeTraceEvent, makeTurnResult } =
      await import("../src/contract/test-fixtures.js");
    const left = await createPgStore(isolated.url, { freshSchema: true });
    const right = await createPgStore(isolated.url);
    const sql = postgres(isolated.url);
    const createdAt = "2026-10-07T00:00:00.000Z";
    try {
      await left.createSession(makeSession({ id: "concurrent" }));
      await Promise.all(
        Array.from({ length: 40 }, async (_, index) => {
          const store = index % 2 === 0 ? left : right;
          const id = `row-${String(40 - index).padStart(3, "0")}`;
          await Promise.all([
            store.addMessage(
              makeMessage({ id, sessionId: "concurrent", createdAt }),
            ),
            store.addTraceEvent(
              makeTraceEvent({ id, sessionId: "concurrent", createdAt }),
            ),
            store.saveTurnResult(
              makeTurnResult({ id, sessionId: "concurrent", createdAt }),
            ),
          ]);
        }),
      );
      for (const table of ["messages", "trace_events", "turn_results"]) {
        const [counts] = await sql.unsafe(
          `SELECT count(*)::int AS total, count(DISTINCT seq)::int AS positions FROM ${table}`,
        );
        expect(counts).toEqual({ total: 40, positions: 40 });
      }
      for (const [list, page] of [
        [
          () => left.listMessages("concurrent"),
          (before?: { id: string; createdAt: string }) =>
            right.listMessagesPage("concurrent", { limit: 7, before }),
        ],
        [
          () => left.listTraceEvents("concurrent"),
          (before?: { id: string; createdAt: string }) =>
            right.listTraceEventsPage("concurrent", { limit: 7, before }),
        ],
      ] as const) {
        const expected = await list();
        const seen: string[] = [];
        let before: { id: string; createdAt: string } | undefined;
        for (;;) {
          const rows = await page(before);
          if (rows.length === 0) break;
          seen.unshift(...rows.map((row) => row.id));
          before = rows[0];
        }
        expect(seen).toEqual(expected.map((row) => row.id));
      }
    } finally {
      await Promise.all([left.close(), right.close(), sql.end()]);
    }
  });
  it("batch CAS serializes independent PostgreSQL clients and rejects partial stale batches", async () => {
    const left = await createPgStore(isolated.url, { freshSchema: true });
    const right = await createPgStore(isolated.url);
    const at = "2026-10-01T00:00:00Z";
    try {
      await left.createSession({
        id: "cas-session",
        worldId: null,
        phase: "playing",
        status: "active",
        setupRuntimes: {},
        completedPlayerTurns: 0,
        metadata: {},
        locale: "en-US",
        activePlugins: [],
        createdAt: at,
        updatedAt: at,
      });
      const batch = (
        expectedVersion: number | null,
        version: number,
        value: number,
      ) =>
        ["one", "two"].map((key) => ({
          namespace: "_dimensions",
          key,
          expectedVersion,
          value: { version, value },
          timestamp: at,
        }));
      expect(
        await left.compareAndSetPluginDataBatch(
          "cas-session",
          "authority",
          batch(null, 1, 0),
        ),
      ).toBe(true);
      const results = await Promise.all([
        left.compareAndSetPluginDataBatch(
          "cas-session",
          "authority",
          batch(1, 2, 1),
        ),
        right.compareAndSetPluginDataBatch(
          "cas-session",
          "authority",
          batch(1, 2, 2),
        ),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const before = await left.listPluginData(
        "cas-session",
        "authority",
        "_dimensions",
      );
      expect(before.map((row) => row.value)).toEqual([
        before[0]!.value,
        before[0]!.value,
      ]);
      expect(before[0]!.value).toMatchObject({ version: 2 });
      const stale = batch(2, 3, 3);
      stale[1]!.expectedVersion = 1;
      expect(
        await right.compareAndSetPluginDataBatch(
          "cas-session",
          "authority",
          stale,
        ),
      ).toBe(false);
      expect(
        await left.listPluginData("cas-session", "authority", "_dimensions"),
      ).toEqual(before);
    } finally {
      await Promise.all([left.close(), right.close()]);
    }
  });
  it("reports a session that is gone at the write barrier with its own error type", async () => {
    const { SessionNotFoundError } = await import("../src/errors.js");
    const store = await createPgStore(isolated.url, { freshSchema: true });
    try {
      // A caller racing with session deletion must be able to tell this from
      // a database failure without issuing another query in the transaction.
      await expect(
        store.withTransaction((tx) =>
          tx.compareAndSetPluginDataBatch("gone-session", "authority", []),
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    } finally {
      await store.close();
    }
  });
} else {
  describe("PgStore (skipped)", () => {
    it.skip("skipped — PostgreSQL not available", () => {});
  });
}
