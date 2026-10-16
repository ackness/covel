### Breaking

- **Data schema version 6: a database written at data schema 5 is refused at startup.** The `events` table drops its unused `target_runtime` column. A SQLite or PostgreSQL database recorded at data schema 5 stops the server with `StoreSchemaVersionError` before any table is changed. Back up the SQLite file with its `-wal` and `-shm` files and start with a new data directory or `SQLITE_PATH`, or point `DATABASE_URL` at a new, empty PostgreSQL database. Browser-private saves need nothing. See `docs/internals/storage.md`.

### Removed

- **`POST /api/events/emit` no longer takes `targetRuntime`.** The field never chose a receiver: the event goes to the clients subscribed to the session and triggers no runtime. A request that still sends the field succeeds, and the field is ignored. See the [API reference](../reference/api.md).
