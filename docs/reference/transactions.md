# Store Transactions

> Covel's `DataStore` interface exposes an imperative transaction contract —
> `beginTx / commitTx / rollbackTx` — that every backend must honor. This
> document captures the contract, the per-backend implementation strategy,
> and how the kernel keeps transactional commits enabled by default while
> still exposing `COVEL_COMMIT_TXN_V1` as an explicit opt-out.

## Contract

```ts
interface DataStore {
  /**
   * Begin a transaction. All subsequent writes on this store handle are
   * buffered until commitTx() or rollbackTx() is called. Nested transactions
   * are NOT supported — calling beginTx() twice without an intervening
   * commit/rollback throws.
   */
  beginTx(): Promise<void>;

  /** Flush buffered writes. No-op if there were none. */
  commitTx(): Promise<void>;

  /**
   * Discard all writes performed since beginTx(). After rollback the store
   * must observe exactly the state it had at the moment beginTx() returned.
   */
  rollbackTx(): Promise<void>;
}
```

### Rules

1. **Single-writer scope.** A store handle has at most one active
   transaction. The tx methods are not reentrant. If a caller needs
   concurrent transactions it must open a second `DataStore` instance.
2. **Rollback restores observable state.** After `rollbackTx()` completes,
   every read method must return the same result it would have returned
   immediately after `beginTx()` returned. Records that existed before
   `beginTx()` are preserved with their original identity; mutations from
   inside the transaction are discarded.
3. **Commit is a best-effort flush.** If `commitTx()` throws, the active
   transaction is considered ended and the store is guaranteed to accept a
   fresh `beginTx()` afterward. Implementations must reset internal
   "transaction active" flags in a `finally` block so that a throwing
   commit does not strand the store in a phantom active state.
4. **Rollback is also flag-resetting.** The same rule applies to
   `rollbackTx()`: even if the restore step fails mid-way, the store must
   accept a fresh `beginTx()` afterward. Half-restored state is allowed,
   lock-out is not.
5. **Writes outside a transaction auto-commit.** Calling any write method
   without an active transaction must be immediately durable, just as it
   was before `S4-T1`.

### Contract tests

`packages/store/src/contract/store-contract.ts` contains the shared
behavioral test suite that every backend runs:

- `rolls back all writes on rollbackTx`
- `commits all writes on commitTx`
- `throws on nested beginTx`
- `throws on commitTx without an active transaction`
- `throws on rollbackTx without an active transaction`

Any new store backend MUST pass this suite.

## Backend implementations

### MemoryStore

Two-phase snapshot using `structuredClone` (Node ≥ 17, native). On
`beginTx()` the store eagerly clones every collection (sessions, turn
results, characters, plugin data, etc.) into a shadow copy. On
`rollbackTx()` it clears each collection in place and refills it from the
shadow so that any existing references the caller is holding stay valid.
`commitTx()` simply discards the shadow.

- File: `packages/store/src/memory/memory-store.ts`
- Failure mode: `structuredClone` cannot clone functions, Proxies, or
  WeakMaps. Covel does not store any of those in state, so
  `DataCloneError` is treated as a programming bug.

### SqliteStore

Direct SQL: `sqlite.exec('BEGIN')` / `'COMMIT'` / `'ROLLBACK'`, with a
`txActive` boolean guarding against nesting. The flag is reset inside a
`finally` block so that a throwing COMMIT or ROLLBACK does not leave the
store locked.

- File: `packages/store/src/sqlite/sqlite-store.ts`

### IdbStore

Eager per-object-store snapshot via `IDBDatabase.transaction().objectStore(name).getAll()`
plus `structuredClone`, mirroring the MemoryStore strategy. On
`rollbackTx()` it clears each object store and refills it from the
snapshot. The snapshot handle is released inside a `finally` block so a
mid-restore failure leaves the store in a half-restored-but-not-locked
state that a subsequent `beginTx()` can recover from.

- File: `packages/store/src/indexeddb/idb-store.ts`
- Runtime environment: browser IndexedDB plus `fake-indexeddb` polyfill
  for tests.

### PgStore

`postgres.js` is a connection pool, so a bare `unsafe('BEGIN')` does not
bind to a specific connection. Drizzle's `db.transaction(async (tx) => ...)`
API reserves a connection and issues BEGIN/COMMIT/ROLLBACK correctly but
is callback-shaped. PgStore adapts that callback API to the imperative
`beginTx / commitTx / rollbackTx` contract via a manual-gate adapter
extracted into `packages/store/src/postgres/pg-store-tx.ts`.

How it works:

1. `beginTx()` spawns `pooledDb.transaction(async (tx) => { setDb(tx); await gate; })`
   in the background and awaits a "ready" promise that resolves once the
   tx callback has swapped the store's mutable `db` handle to the
   tx-scoped drizzle instance. Every subsequent data method uses this
   handle, so reads and writes route through the transaction.
2. `commitTx()` resolves the gate promise. The callback returns cleanly,
   drizzle issues `COMMIT`, and the `.finally` block restores the pooled
   handle.
3. `rollbackTx()` rejects the gate with a sentinel error
   (`{ _covelRollback: ROLLBACK_SENTINEL }`). The callback throws, drizzle
   issues `ROLLBACK` and rethrows; the adapter swallows the sentinel and
   lets any non-sentinel error surface.
4. `close()` calls `closeActiveTx()` which does a best-effort rollback
   before `client.end()`, so a store teardown mid-transaction does not
   leak a reserved pool connection.

The `ROLLBACK_SENTINEL` is a module-local `Symbol`, which means it cannot
be spoofed from outside the module — an unrelated thrown error will never
be mistaken for a cooperative rollback.

- Files:
  - `packages/store/src/postgres/pg-store.ts` — factory, wires the adapter
  - `packages/store/src/postgres/pg-store-tx.ts` — adapter implementation

## Kernel integration

Turn commit (`packages/runtime/src/session-kernel.ts:commitAll`) runs in
a transaction by default. When the underlying store implements
`beginTx` (the method is optional on `KernelStore` for backwards
compatibility), `commitAll` wraps the proposal application in a single
transaction. Operators can explicitly opt out with
`COVEL_COMMIT_TXN_V1=0` or `COVEL_COMMIT_TXN_V1=false`:

```ts
const txEnabled = process.env.COVEL_COMMIT_TXN_V1 !== '0' &&
  process.env.COVEL_COMMIT_TXN_V1 !== 'false';

if (txEnabled && typeof store.beginTx === 'function') {
  await store.beginTx();
  try {
    // apply every proposal in order
    await applyProposals(proposals);
    await store.commitTx!();
  } catch (err) {
    try {
      await store.rollbackTx!();
    } catch {
      // swallow — the original commit error is the one we want to surface
    }
    throw err;
  }
}
```

Explicit opt-out preserves the legacy behavior from before `S4-T1`
(serial apply, no rollback on mid-sequence failure).

### Opting out

Set the env var at server boot:

```bash
COVEL_COMMIT_TXN_V1=0 pnpm dev:server
# or
COVEL_COMMIT_TXN_V1=false pnpm dev:pg
```

Default path: leave the variable unset, or set it to `1` / `true`.

### Observability

Transactional commits still produce the same `trace_events` as
non-transactional commits (proposal apply, commit success/failure). The
trace does not currently distinguish the two code paths — if you need to
tell them apart during a gradual rollout, check whether
`COVEL_COMMIT_TXN_V1` is set in the process env.

## Schema migrations

Schema changes in `packages/store/src/{sqlite,postgres}/*-store-mappers.ts` use
`CREATE TABLE IF NOT EXISTS` and additive `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` so fresh installs and existing databases both boot. The store
package does **not** ship destructive auto-migrations — when a constraint
becomes stricter (e.g. `media_refs UNIQUE` was widened from
`(session_id, media_id, plugin_id)` to `(session_id, media_id)` to fix
NULL-pluginId duplicate rows; see [`media-store.md`](./media-store.md#ownership)),
the DDL still creates the new index, but operators with legacy duplicates
must run a one-off cleanup SQL before the new index can be applied. Each
such migration is documented next to the affected table in the relevant
reference doc.

## References

- Contract type: `packages/store/src/types.ts` (`DataStore` interface)
- Contract tests: `packages/store/src/contract/store-contract.ts`
- PgStore adapter: `packages/store/src/postgres/pg-store-tx.ts`
- Kernel commit path: `packages/runtime/src/session-kernel.ts`
- MediaStore schema + S3 metadata adapter: [`media-store.md`](./media-store.md)
