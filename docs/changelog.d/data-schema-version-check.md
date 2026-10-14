### Changed

- **Covel refuses a database written by another data schema instead of failing later.** SQLite records the data schema version in `PRAGMA user_version` and PostgreSQL in `covel_schema_meta`. A database recorded with another version, or an older one that lacks a column, is refused at startup before any table is touched, with `StoreSchemaVersionError` telling you to back up and use a new data directory; the desktop app shows this on its startup screen. Before, such a database opened and then failed with `no such column` on use. Rule: `docs/internals/storage.md#capabilities-and-migrations`.

### Fixed

- **PostgreSQL servers that start together no longer fail on table creation.** Startup table creation now runs under one advisory lock, so two servers booting against one database create the tables in turn.

### Upgrade notes

- A database written by the current build opens as before and is stamped with the version on its first start. If startup reports "Data from another Covel version", back up the data directory and set a new `data_root` (desktop), `SQLITE_PATH` or `DATABASE_URL`.
