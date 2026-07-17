/**
 * PostgreSQL schema DDL re-exports.
 *
 * Row→record mapping for PG lives directly in the shared
 * `common/sql-*-records.ts` query layer (bound to `pgJsonReader`); this
 * module now only forwards DDL constants from `pg-schema-ddl.ts`.
 */

export {
  CREATE_MEDIA_TABLES_SQL,
  CREATE_TABLES_SQL,
  DROP_ALL_SQL,
} from "./pg-schema-ddl.js";
