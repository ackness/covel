/**
 * Print the boot DDL derived from the Drizzle schema, for review / debugging.
 *
 *   pnpm --filter @covel/store generate-ddl            # both dialects
 *   pnpm --filter @covel/store generate-ddl -- sqlite  # one dialect
 *   pnpm --filter @covel/store generate-ddl -- pg
 *
 * The DDL is NOT a committed artifact — it is derived at boot from the Drizzle
 * schema (the single source of truth). This script only materializes the same
 * derivation so a human can read or diff the exact SQL a backend will execute.
 */

import { CREATE_TABLES_SQL as SQLITE_DDL } from "../src/sqlite/sqlite-schema-ddl.js";
import { CREATE_TABLES_SQL as PG_DDL } from "../src/postgres/pg-schema-ddl.js";

const which = process.argv[2];

if (!which || which === "sqlite") {
  console.log("-- ===== SQLite boot DDL (derived from Drizzle schema) =====");
  console.log(SQLITE_DDL);
}
if (!which || which === "pg") {
  if (!which) console.log("\n");
  console.log(
    "-- ===== PostgreSQL boot DDL (derived from Drizzle schema) =====",
  );
  console.log(PG_DDL);
}
