/**
 * Startup check of the SQL data schema version, shared by SQLite and
 * PostgreSQL so both refuse the same databases.
 *
 * Covel does not migrate stored data (current contract only). Without this
 * check, `CREATE TABLE IF NOT EXISTS` leaves an older table as it is and the
 * mismatch surfaces later as `no such column` on some query. Each boot reads
 * the recorded version before any DDL runs:
 *
 * - equal to {@link DATA_SCHEMA_VERSION}: open;
 * - any other recorded version (older or newer): refuse;
 * - nothing recorded (a new database, or one written before the version was
 *   recorded): open only when every existing Covel table has every column the
 *   current schema needs. Missing tables are fine; the boot DDL creates them.
 *
 * After the DDL the boot records the current version.
 */

import { StoreSchemaVersionError } from "../errors.js";
import { DATA_SCHEMA_VERSION } from "../migrations.js";

/** Columns the database has now, keyed by table name; absent tables are omitted. */
export type ExistingColumns = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Throw {@link StoreSchemaVersionError} when a version is recorded and it is
 * not this build's. `found` is null when no version is recorded; the caller
 * then checks the columns with {@link assertColumnsPresent}.
 */
export function assertRecordedVersion(
  backend: "sqlite" | "pg",
  database: string,
  found: number | null,
): void {
  if (found !== null && found !== DATA_SCHEMA_VERSION) {
    throw new StoreSchemaVersionError(
      backend,
      database,
      found,
      DATA_SCHEMA_VERSION,
    );
  }
}

/**
 * Throw {@link StoreSchemaVersionError} when a Covel table that already exists
 * lacks a column of the current schema. Missing tables are fine.
 */
export function assertColumnsPresent(
  backend: "sqlite" | "pg",
  database: string,
  expectedColumns: ReadonlyMap<string, readonly string[]>,
  existingColumns: ExistingColumns,
): void {
  const missing: string[] = [];
  for (const [table, columns] of expectedColumns) {
    const present = existingColumns.get(table);
    if (!present) continue;
    for (const column of columns) {
      if (!present.has(column)) missing.push(`${table}.${column}`);
    }
  }
  if (missing.length > 0) {
    throw new StoreSchemaVersionError(
      backend,
      database,
      null,
      DATA_SCHEMA_VERSION,
      missing,
    );
  }
}
