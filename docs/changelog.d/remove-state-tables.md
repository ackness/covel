### Breaking

- **The SQL data schema moves from 6 (v0.0.53) to 8, so databases created by v0.0.53 must be recreated.** Sessions gain a required `seats` column, and the kernel state tables `state_schemas`, `state_entries` and `state_changes` are removed. Delete the SQLite development database (`data/covel.db`) and the desktop database, and recreate the PostgreSQL development database volume; snapshots stored in those databases are removed with them. No migration is provided.
- **Session views contain no kernel state-table aggregate, and `/state-patches` is removed.** `GET /view` no longer returns `gameState`; `GET /state` lists only the session, characters and public plugin data; `GET /api/sessions/:id/state-patches` no longer exists. Forks no longer return `409 snapshot_schema_missing`. See the API reference. Snapshot payload, browser checkpoint, BrowserVault and browser cache versions remain unchanged.

### Removed

- **The state patch cache pipeline is removed.** The Database tab fetches on mount and on manual refresh.
- **The debugger's Game State section is removed.** Characters, plugin data and execution steps remain available.
