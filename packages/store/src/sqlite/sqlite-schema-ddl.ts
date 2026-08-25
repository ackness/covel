/**
 * SQLite boot DDL.
 *
 * Table + index DDL is DERIVED from the Drizzle schema (`./schema.ts`) — the
 * single source of truth — via {@link buildCreateTablesSql}. There is no longer
 * a hand-maintained copy of the column/index definitions here; editing a column
 * means editing the Drizzle table, and this DDL follows automatically.
 *
 * The only thing Drizzle cannot model stays hand-written below: the
 * `vector_models` table-name backfill trigger.
 *
 * The schema↔DDL parity guard lives in `tests/schema-index-consistency.test.ts`
 * and `tests/schema-ddl-codegen.test.ts`.
 */

import { buildCreateTablesSql } from "../common/ddl-codegen.js";
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

export function createTables(sqlite: { exec(sql: string): void }): void {
  sqlite.exec(CREATE_TABLES_SQL);
  sqlite.exec(VECTOR_MODELS_TRIGGER_SQL);
}
