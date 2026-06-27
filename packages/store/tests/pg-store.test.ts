import { runStoreContractTests } from "../src/contract/store-contract.js";
import { describe, it, expect } from "vitest";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";

// Check if PG is available before running the suite
let pgAvailable = false;
try {
  const { default: postgres } = await import("postgres");
  const client = postgres(DATABASE_URL, { connect_timeout: 3 });
  await client`SELECT 1`;
  await client.end();
  pgAvailable = true;
} catch {
  console.warn("PostgreSQL not available, skipping PgStore tests");
}

if (pgAvailable) {
  const { createPgStore } = await import("../src/postgres/pg-store.js");
  const { createIsolatedPgUrl } = await import("./pg-test-db.js");
  // Own database so this file never races concurrent PG test files on schema DDL.
  const isolatedUrl = await createIsolatedPgUrl(
    DATABASE_URL,
    "covel_test_pgstore",
  );

  runStoreContractTests("PgStore", async () => {
    const store = await createPgStore(isolatedUrl, { freshSchema: true });
    return store;
  });
} else {
  describe("PgStore (skipped)", () => {
    it("skipped — PostgreSQL not available", () => {
      expect(true).toBe(true);
    });
  });
}
