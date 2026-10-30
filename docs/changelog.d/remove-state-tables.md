### Breaking

- **SQL data schema 8 removes the kernel state tables.** `state_schemas`, `state_entries` and `state_changes` are gone. Recreate schema-7 SQLite development databases (`data/covel.db` and the desktop database) and the PostgreSQL development database volume; snapshots stored in those databases are removed with them. No migration is provided.
- **Session views contain no kernel state-table aggregate.** `GET /view` no longer returns `gameState`; `GET /state` lists only the session, characters and public plugin data. Forks no longer return `409 snapshot_schema_missing`. See the API reference. Snapshot payload, browser checkpoint, BrowserVault and browser cache versions remain unchanged.

### Removed

- **The state patch endpoint and cache pipeline are removed.** `/state-patches` is gone. The Database tab fetches on mount and manual refresh.
- **The debugger's Game State section is removed.** Characters, plugin data and execution steps remain available.
