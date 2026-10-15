### Fixed

- **Schema startup errors identify the database that was refused.** `StoreSchemaVersionError.database` and its message include the absolute SQLite file path, or the PostgreSQL host, port and database name without credentials. SQLite errors explain how to move aside or delete disposable development data. The development-path documentation now distinguishes an existing Covel home from the `apps/server/data/covel.db` fallback.
