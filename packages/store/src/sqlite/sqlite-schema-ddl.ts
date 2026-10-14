/**
 * SQLite boot DDL.
 *
 * Table + index DDL is DERIVED from the Drizzle schema (`./schema.ts`) — the
 * single source of truth — via {@link buildCreateTablesSql}. There is no longer
 * a hand-maintained copy of the column/index definitions here; editing a column
 * means editing the Drizzle table, and this DDL follows automatically.
 *
 * The only things Drizzle cannot model stay hand-written: the `vector_models`
 * table-name backfill trigger below and the write-order triggers
 * (`common/write-order-ddl.ts`).
 *
 * The schema↔DDL parity guard lives in `tests/schema-index-consistency.test.ts`
 * and `tests/schema-ddl-codegen.test.ts`.
 */

import { buildCreateTablesSql, tableColumnsOf } from "../common/ddl-codegen.js";
import {
  assertColumnsPresent,
  assertRecordedVersion,
  type ExistingColumns,
} from "../common/schema-version.js";
import { sqliteWriteOrderTriggersSql } from "../common/write-order-ddl.js";
import { DATA_SCHEMA_VERSION } from "../migrations.js";
import {
  DELETE_RETIRED_PLUGIN_DATA_SQL,
  DROP_RETIRED_TABLES_SQL,
} from "../table-registry.js";
import * as schema from "./schema.js";

/**
 * `CREATE TABLE IF NOT EXISTS` + index DDL for every Drizzle table, generated
 * from the schema. Order follows the (deterministic) module-namespace key sort;
 * with zero foreign keys the order is not load-bearing.
 */
export const CREATE_TABLES_SQL = buildCreateTablesSql(
  Object.values(schema),
  "sqlite",
);

/**
 * Atomic `table_name` backfill: SQLite AFTER INSERT triggers see the generated
 * rowid via NEW.id. The UPDATE runs in the same implicit transaction as the
 * INSERT, so readers always see a populated row. Drizzle does not model
 * triggers, so this is hand-written and executed right after table creation.
 */
const VECTOR_MODELS_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS vector_models_fill_table_name
    AFTER INSERT ON vector_models
    FOR EACH ROW
    WHEN NEW.table_name = '' OR NEW.table_name IS NULL
  BEGIN
    UPDATE vector_models
       SET table_name = 'vec_mem_m' || NEW.id
     WHERE id = NEW.id;
  END;
`;

const EXPECTED_COLUMNS = tableColumnsOf(Object.values(schema), "sqlite");

interface SqliteDdlConnection {
  exec(sql: string): void;
  prepare(sql: string): { get(): unknown; all(): unknown[] };
}

function existingColumns(sqlite: SqliteDdlConnection): ExistingColumns {
  const columns = new Map<string, ReadonlySet<string>>();
  for (const table of EXPECTED_COLUMNS.keys()) {
    const rows = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as {
      name: string;
    }[];
    if (rows.length > 0) columns.set(table, new Set(rows.map((r) => r.name)));
  }
  return columns;
}

/**
 * Check the recorded schema version (`PRAGMA user_version`, 0 = none), create
 * the current tables, then record the version. Throws
 * `StoreSchemaVersionError` before any DDL when the file was written by a
 * build with another data schema (see `common/schema-version.ts`).
 */
export function createTables(sqlite: SqliteDdlConnection): void {
  const row = sqlite.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  const found = row.user_version === 0 ? null : row.user_version;
  assertRecordedVersion("sqlite", found);
  if (found === null) {
    assertColumnsPresent("sqlite", EXPECTED_COLUMNS, existingColumns(sqlite));
  }
  sqlite.exec(CREATE_TABLES_SQL);
  sqlite.exec(VECTOR_MODELS_TRIGGER_SQL);
  sqlite.exec(sqliteWriteOrderTriggersSql());
  sqlite.exec(DROP_RETIRED_TABLES_SQL);
  sqlite.exec(DELETE_RETIRED_PLUGIN_DATA_SQL);
  if (found === null) {
    sqlite.exec(`PRAGMA user_version = ${DATA_SCHEMA_VERSION}`);
  }
}
