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
} else {
  describe("PgStore (skipped)", () => {
    it("skipped — PostgreSQL not available", () => {
      expect(true).toBe(true);
    });
  });
}
