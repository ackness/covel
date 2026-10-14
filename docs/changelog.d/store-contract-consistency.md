### Fixed

- **MemoryStore, SQLite and PostgreSQL now agree on four storage rules.**
  - Rows with the same timestamp come back in the same order on every backend: events, state changes, interaction records, snapshots and suspensions break ties by ID, and state schemas are listed by table name, so an update no longer moves a row on PostgreSQL and snapshots and checkpoints list them in a stable order.
  - MemoryStore rejects a second turn result, tool call, runtime output, interaction record, state change, event, trace, player input or session summary under an existing ID, as SQLite and PostgreSQL always did.
  - A batch of lorebook entries is written whole or not at all on SQLite and PostgreSQL.
  - A transaction no longer copies every MemoryStore collection when it calls `queryTurnResults`, `queryTraceEvents` or `queryPluginData`.

### Changed

- **Inside `withTransaction`, write only through `tx`.** A `DataStore` write made through the root store from inside the callback now throws `RootStoreWriteInTransactionError` on every backend and writes nothing; it used to join the transaction on SQLite and commit on its own on PostgreSQL. Plugin authors are not affected: plugins never see the store.
