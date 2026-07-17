/**
 * SQLite schema DDL re-export.
 *
 * Row→record mapping for SQLite lives directly in the shared
 * `common/sql-*-records.ts` query layer (bound to `sqliteJsonReader`); this
 * module now only forwards `createTables` from `sqlite-schema-ddl.ts`.
 */

export { createTables } from "./sqlite-schema-ddl.js";
