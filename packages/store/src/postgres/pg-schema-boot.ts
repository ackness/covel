/**
 * PostgreSQL boot: version check, DDL and version record in one transaction.
 *
 * Every step runs under one transaction-scoped advisory lock, so servers that
 * start together against one database (rolling deploys, several pods) run the
 * boot DDL one after another instead of racing on the system catalog. The
 * standalone media store takes the same lock for its own DDL.
 *
 * The version check is the one SQLite does (`common/schema-version.ts`); the
 * version lives in the single-row table {@link SCHEMA_META_TABLE}.
 */

import type { Sql, TransactionSql } from "postgres";

import { tableColumnsOf } from "../common/ddl-codegen.js";
import {
  assertColumnsPresent,
  assertRecordedVersion,
  type ExistingColumns,
} from "../common/schema-version.js";
import { DATA_SCHEMA_VERSION } from "../migrations.js";
import { CREATE_TABLES_SQL } from "./pg-schema-ddl.js";
import * as schema from "./schema.js";

/** Serialises boot DDL across processes; released when the transaction ends. */
export const SCHEMA_DDL_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('covel:schema-ddl'))";

/** Single-row table that records the data schema version. */
export const SCHEMA_META_TABLE = "covel_schema_meta";

const EXPECTED_COLUMNS = tableColumnsOf(Object.values(schema), "pg");

async function readRecordedVersion(
  sql: TransactionSql,
): Promise<number | null> {
  const [meta] = await sql<{ present: boolean }[]>`
    SELECT to_regclass(${SCHEMA_META_TABLE}) IS NOT NULL AS present
  `;
  if (!meta?.present) return null;
  const [row] = await sql<{ schema_version: number }[]>`
    SELECT schema_version FROM ${sql(SCHEMA_META_TABLE)} WHERE id = 1
  `;
  return row ? row.schema_version : null;
}

async function existingColumns(sql: TransactionSql): Promise<ExistingColumns> {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
  `;
  const columns = new Map<string, Set<string>>();
  for (const { table_name, column_name } of rows) {
    let set = columns.get(table_name);
    if (!set) {
      set = new Set();
      columns.set(table_name, set);
    }
    set.add(column_name);
  }
  return columns;
}

/**
 * Check the recorded version, create the current tables and record the
 * version. Throws `StoreSchemaVersionError` before any DDL when the database
 * was written by a build with another data schema.
 */
export async function bootPgSchema(client: Sql): Promise<void> {
  // Select only endpoint fields: connection URLs and options also hold credentials.
  const { host, port, database: name } = client.options;
  const database = `${host.map((value, i) => `${value}:${port[i] ?? port[0]}`).join(",")}/${name}`;
  await client.begin(async (sql) => {
    await sql.unsafe(SCHEMA_DDL_LOCK_SQL);
    const found = await readRecordedVersion(sql);
    assertRecordedVersion("pg", database, found);
    if (found === null) {
      assertColumnsPresent(
        "pg",
        database,
        EXPECTED_COLUMNS,
        await existingColumns(sql),
      );
    }
    await sql.unsafe(CREATE_TABLES_SQL);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA_META_TABLE} (
        id integer PRIMARY KEY CHECK (id = 1),
        schema_version integer NOT NULL
      )
    `);
    await sql`
      INSERT INTO ${sql(SCHEMA_META_TABLE)} (id, schema_version)
      VALUES (1, ${DATA_SCHEMA_VERSION})
      ON CONFLICT (id) DO UPDATE SET schema_version = EXCLUDED.schema_version
    `;
  });
}
