# Store Transactions

> Covel's `DataStore` interface exposes an imperative transaction contract —
> `beginTx / commitTx / rollbackTx` — that every backend must honor. This
> document captures the contract, the per-backend implementation strategy,
> and how the kernel uses transactional commits whenever the active store
> backend exposes transaction methods.

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

It also covers the scoped `withTransaction` API (see below):

- `commits all writes when the callback resolves`
- `rolls back all writes and rethrows when the callback throws`
- `returns the callback result`
- `does not swallow writes across concurrent transactions`
- `rolls back only the failing concurrent transaction`
- `rejects a nested withTransaction with a clear error instead of deadlocking`
- `recovers and accepts a fresh withTransaction after a nested rejection`

Any new store backend MUST pass this suite.

## Backend implementations

### MemoryStore

Two-phase snapshot using a **shallow reference copy** of each collection
(`new Map(value)` / `[...value]`), not a deep clone. On `beginTx()` the store
eagerly snapshots every collection (sessions, turn results, characters, plugin
data, etc.) by copying the container while sharing the same record references.
On `rollbackTx()` it clears each collection in place and refills it from the
shadow so that any existing references the caller is holding stay valid.
`commitTx()` simply discards the shadow.

- File: `packages/store/src/memory/transaction-methods.ts`
- Invariant: correctness relies on records being treated as **immutable** —
  mutations must replace the record (new object), never mutate in place. This
  is why an O(row-count) reference copy is safe and why it replaced the previous
  `structuredClone` deep copy (audit 2026-06-04 finding H3): deep cloning was
  unnecessary given the never-mutate-in-place contract and far more expensive.

### SqliteStore

Direct SQL: `sqlite.exec('BEGIN')` / `'COMMIT'` / `'ROLLBACK'`, with a
`txActive` boolean guarding against nesting. The flag is reset inside a
`finally` block so that a throwing COMMIT or ROLLBACK does not leave the
store locked.

- File: `packages/store/src/sqlite/sqlite-store.ts`

### IdbStore

Lazy first-touch snapshot. `beginTx()` 不会预先 `getAll()` 全部 object
store —— 那样会和并发的 SSE / interval / 其他 tab 写入冲突。它只初始化
两个跟踪结构：`idbSnapshot: Map<storeName, rows[]>` 与
`touchedStores: Set<storeName>`。每次 `put` / `delete` 通过
`ensureStoreSnapshot(name)` 检查 `touchedStores`：首次 mutation 时调用
`db.getAll(name)` + `structuredClone` 把当前 rows 抓进 `idbSnapshot`
并把 name 加进 set，后续 mutation 命中 set 直接跳过。`rollbackTx()`
只 clear + refill `touchedStores` 中的 object store，未触碰的 store
完全不动 —— 因此事务开启后落入未触碰 store 的并发写入不会被 rollback
覆盖。`commitTx()` / `rollbackTx()` 都在 `finally` 块清空 `idbSnapshot`
和 `touchedStores`，保证一次失败的 commit/rollback 不会卡住下一次
`beginTx()`。

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

## Scoped transactions (`withTransaction`)

Alongside the imperative trio, `DataStore` exposes a scoped, callback-shaped
transaction API:

```ts
interface DataStore {
  withTransaction?: <T>(fn: (tx: StoreTransaction) => Promise<T>) => Promise<T>;
}
```

`fn` receives a transaction-bound store view (`StoreTransaction` — every
read/write method, minus the tx-control and lifecycle methods). Writes through
that view commit atomically when `fn` resolves and roll back if it throws (the
error is re-thrown to the caller). Unlike the imperative shim, `withTransaction`
never mutates a shared/global handle, so the tx scope is bound to the single
`fn` invocation.

This is the **preferred** transaction API. The imperative
`beginTx / commitTx / rollbackTx` trio is retained as a compatibility shim for
existing callers (the kernel commit path still uses it). As of this writing
`withTransaction` has no production callers — it is wired and contract-tested,
ready for adoption.

### Cross-backend semantics (read before adopting)

The four backends honor the same observable contract (atomic commit / rollback,
nested-call rejection) but differ in concurrency and isolation:

| Backend                                  | Concurrency model                                                                                                                                                                       | Concurrent non-tx write during a callback                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **PgStore**                              | Each call runs on its **own pooled connection** (Drizzle `db.transaction`) — true parallel transactions.                                                                                | Isolated on its own connection; not folded in.                            |
| **SqliteStore / MemoryStore / IdbStore** | **Single connection / single snapshot.** Concurrent calls are **serialized** through a promise chain — each runs its full BEGIN…COMMIT before the next starts, so neither loses writes. | **Folded into the open transaction** and committed / rolled back with it. |

> ⚠️ **Serialized-backend caveat.** On SQLite / Memory / IndexedDB there is one
> connection (or one in-flight snapshot) at a time, so **any** other write
> issued on the same store while a `withTransaction` callback is mid-flight —
> including writes that do **not** go through `withTransaction` — runs on the
> open transaction and is committed or rolled back with it. Do not interleave
> unrelated writes with a serialized transaction; if you need an isolated
> concurrent write, use PgStore or a second store instance.

### Nesting is rejected on every backend

Calling `withTransaction` from inside another `withTransaction` callback is a
programming error and is **rejected synchronously with a clear error** on all
four backends:

- **Serialized backends (SQLite / Memory / IndexedDB):** the inner call would
  queue behind the outer transaction _on the serialization chain_ — and the
  outer call is awaiting the inner — a permanent **deadlock**. The guard turns
  that silent hang into an immediate rejection.
- **PgStore:** nesting would not deadlock (independent connection), but the
  inner call would run as a **separate, non-atomic transaction** — an outer
  rollback would not undo the inner commit. It is rejected anyway, for a uniform
  contract and to prevent that silent atomicity surprise.

The error message: `"<Store>: nested withTransaction is not supported on the
<backend> backend; <reason>. Flatten the nested call, or perform the inner
writes directly through the outer callback's tx scope."`

#### How nesting is detected

- **SqliteStore / MemoryStore / PgStore (Node):** an `AsyncLocalStorage` scope
  (`packages/store/src/tx-nesting-guard.ts`) marks the running callback's async
  context. `isNested()` — checked synchronously when a new `withTransaction` is
  entered — returns `true` only for a re-entrant (nested) call and `false` for an
  independent concurrent caller, so legitimate concurrency is never misflagged.
- **IdbStore (browser):** `AsyncLocalStorage` is unavailable in the browser
  bundle, so it uses a coarser synchronous boolean. It reliably rejects nesting
  (the deadlock case) but may also reject a genuinely concurrent call issued
  while another callback is mid-flight — an edge that is irrelevant for IdbStore's
  single-user local mode.

The shared error builder lives in `packages/store/src/tx-nesting-error.ts`
(browser-safe; imported by every backend). The AsyncLocalStorage guard is
Node-only and is never pulled into the IdbStore browser bundle.

## Kernel integration

Turn commit (`packages/runtime/src/commit/session-commit-pipeline.ts`) uses a
transaction whenever the underlying store implements `beginTx`, `commitTx`,
and `rollbackTx`. `packages/runtime/src/session/session-kernel.ts` remains the public
facade for processing runtime results. Store adapters that do not expose the
transaction trio still execute proposals sequentially and warn on partial
commit failure.

```ts
const supportsTx =
  typeof store.beginTx === "function" &&
  typeof store.commitTx === "function" &&
  typeof store.rollbackTx === "function";

if (supportsTx) {
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

The non-transactional path is reserved for stores that genuinely lack the
transaction contract.

## World Data import

Session creation with `worldData` uses the same `DataStore` transaction
contract. The server builds and validates the import plan first, then wraps
the session row plus importer-managed writes in one transaction:

- `sessions`
- `plugin_data`
- `lorebook`
- `characters`
- media index rows stored in `plugin_data`
- `world_data_import_ledger`

`world_data_import_ledger` records provenance for every importer-managed
session row: target, plugin id, namespace, key, source digest, value hash,
schema ref, source id, and managed flag. `/api/worlds/:id/sync-data` uses
that ledger for dry-run, hash-based conflict detection, and explicit
`force` sync.

Media bytes live in `MediaStore`, which has a separate lifecycle from
`DataStore`. World-data import validates media during preflight, writes the
media object before the session-store media index row, and rolls back the
`DataStore` transaction on failure. Sync deletion of importer-managed media
index rows removes only the current session's explicit media ref; the
content-addressed media asset is deleted only when the current session owns it
and no refs remain.

### Observability

Transactional commits produce the same `trace_events` as non-transactional
commits (proposal apply, commit success/failure). The trace does not currently
add a dedicated transaction-mode field; inspect the active store backend when
debugging whether a run used transactions.

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
- Contract tests: `packages/store/src/contract/store-contract.ts` and `packages/store/src/contract/suites/`
- PgStore adapter: `packages/store/src/postgres/pg-store-tx.ts`
- `withTransaction` nesting guard: `packages/store/src/tx-nesting-guard.ts` (Node-only AsyncLocalStorage) and `packages/store/src/tx-nesting-error.ts` (browser-safe error builder)
- Kernel commit path: `packages/runtime/src/commit/session-commit-pipeline.ts`, `packages/runtime/src/commit/session-commit-handlers.ts`
- MediaStore schema + S3 metadata adapter: [`media-store.md`](./media-store.md)
