import { afterAll, describe, expect, it } from "vitest";

import { StoreSchemaVersionError } from "../src/errors.js";
import { DATA_SCHEMA_VERSION } from "../src/migrations.js";
import { runSchemaVersionTests } from "./schema-version-suite.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";
const REQUIRE_PG = process.env.COVEL_REQUIRE_PG_TESTS === "1";

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
  console.warn("PostgreSQL not available, skipping PgStore schema tests");
}

if (pgAvailable) {
  const { default: postgres } = await import("postgres");
  const { createPgStore } = await import("../src/postgres/pg-store.js");
  const { DROP_ALL_SQL } = await import("../src/postgres/pg-schema-ddl.js");
  const { SCHEMA_META_TABLE } =
    await import("../src/postgres/pg-schema-boot.js");
  const { createIsolatedPgDatabase } = await import("./pg-test-db.js");
  const isolated = await createIsolatedPgDatabase(
    DATABASE_URL,
    "covel_test_schema_version",
  );
  const sql = postgres(isolated.url, { max: 1, onnotice: () => {} });
  afterAll(async () => {
    await sql.end();
    await isolated.cleanup();
  });

  it("names the PostgreSQL database without connection credentials", async () => {
    await sql.unsafe(`
      CREATE TABLE ${SCHEMA_META_TABLE} (id integer PRIMARY KEY, schema_version integer NOT NULL);
      INSERT INTO ${SCHEMA_META_TABLE} VALUES (1, ${DATA_SCHEMA_VERSION});
    `);
    await sql`
      UPDATE ${sql(SCHEMA_META_TABLE)} SET schema_version = ${DATA_SCHEMA_VERSION - 1}
    `;
    const url = new URL(isolated.url);
    const database = `${url.hostname}:${url.port || "5432"}${url.pathname}`;
    const error = await createPgStore(isolated.url).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StoreSchemaVersionError);
    expect(error).toMatchObject({
      database,
      message: expect.stringContaining(database),
    });
    if (!(error instanceof StoreSchemaVersionError)) throw error;
    expect(error.message).not.toContain(`${url.username}:`);
    if (url.password) {
      expect(error.message).not.toContain(url.password);
      expect(error.database).not.toContain(url.password);
    }
  });

  runSchemaVersionTests("PgStore", () => ({
    async reset() {
      await sql.unsafe(DROP_ALL_SQL);
      await sql.unsafe(`DROP TABLE IF EXISTS ${SCHEMA_META_TABLE}`);
    },
    async open() {
      return createPgStore(isolated.url);
    },
    async recordedVersion() {
      const [meta] = await sql<{ present: boolean }[]>`
        SELECT to_regclass(${SCHEMA_META_TABLE}) IS NOT NULL AS present
      `;
      if (!meta?.present) return null;
      const [row] = await sql<{ schema_version: number }[]>`
        SELECT schema_version FROM ${sql(SCHEMA_META_TABLE)}
      `;
      return row ? row.schema_version : null;
    },
    async setRecordedVersion(version) {
      if (version === null) {
        await sql.unsafe(`DROP TABLE IF EXISTS ${SCHEMA_META_TABLE}`);
        return;
      }
      await sql`
        UPDATE ${sql(SCHEMA_META_TABLE)} SET schema_version = ${version}
      `;
    },
    async replaceWorldsWithOldTable() {
      await sql.unsafe(
        "DROP TABLE worlds; CREATE TABLE worlds (id text PRIMARY KEY);",
      );
    },
    async worldsColumns() {
      const rows = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'worlds'
        ORDER BY ordinal_position
      `;
      return rows.map((row) => row.column_name);
    },
  }));
} else {
  describe("PgStore schema version (skipped)", () => {
    it.skip("skipped — PostgreSQL not available", () => {});
  });
}
