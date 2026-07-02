# Store Transactions

> Covel's `DataStore` interface exposes a single scoped transaction contract —
> `withTransaction(fn)` — that every backend must honor. This document captures
> the contract, the per-backend implementation strategy, and how the kernel uses
> transactional commits whenever the active store backend exposes it.

## Contract

```ts
interface DataStore {
  /**
   * Run `fn` inside a scoped transaction and return its result. `fn` receives a
   * transaction-bound store view (`StoreTransaction` — every read/write method,
   * minus the tx-control and lifecycle methods). Writes through that view commit
   * atomically when `fn` resolves and roll back if it throws (the error is
   * re-thrown to the caller). No shared/global handle is mutated, so the tx scope
   * is bound to the single `fn` invocation.
   *
   * Optional so partial mock stores remain assignable; all bundled backends
   * implement it.
   */
  withTransaction?: <T>(fn: (tx: StoreTransaction) => Promise<T>) => Promise<T>;
}
```

### Rules

1. **Atomic on resolve / throw.** When `fn` resolves, every write made through
   the `tx` view is committed together. When `fn` throws, all of them roll back
   and the error re-throws to the caller.
2. **Rollback restores observable state.** After a rolled-back transaction every
   read method returns the same result it would have returned immediately before
   the transaction started. Records that existed before are preserved with their
   original identity; mutations from inside the transaction are discarded.
3. **No shared handle.** The tx scope is bound to the single `fn` invocation, so
   the outer store is never left in a "transaction active" state — a failed
   transaction never strands the store.
4. **Writes outside a transaction auto-commit.** Calling any write method
   without a surrounding `withTransaction` is immediately durable.
5. **Nesting is rejected** on every backend (see below).

### Contract tests

`packages/store/src/contract/store-contract.ts` runs the shared behavioral
suite (`contract/suites/integrity-suites.ts`, `withTransaction` group) that every
backend must pass:

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
(`new Map(value)` / `[...value]`), not a deep clone. On transaction start the
store snapshots every collection (sessions, turn results, characters, plugin
data, etc.) by copying the container while sharing the same record references. On
rollback it clears each collection in place and refills it from the shadow so
that any existing references the caller is holding stay valid. On commit it simply
discards the shadow.

- File: `packages/store/src/memory/transaction-methods.ts`
- Invariant: correctness relies on records being treated as **immutable** —
  mutations must replace the record (new object), never mutate in place. This
  is why an O(row-count) reference copy is safe and why it replaced the previous
  `structuredClone` deep copy (audit 2026-06-04 finding H3): deep cloning was
  unnecessary given the never-mutate-in-place contract and far more expensive.

### SqliteStore

Direct SQL: `sqlite.exec('BEGIN')` / `'COMMIT'` / `'ROLLBACK'`. better-sqlite3 is
a single synchronous connection, so `withTransaction` **serializes** concurrent
calls through a promise chain — each runs its full BEGIN…COMMIT before the next
starts, so neither loses writes.

- File: `packages/store/src/sqlite/sqlite-transactions.ts`

### IdbStore

Lazy first-touch snapshot. `withTransaction` wraps an internal snapshot primitive
that does not pre-`getAll()` every object store —— 那样会和并发的 SSE / interval /
其他 tab 写入冲突。它只初始化两个跟踪结构：`idbSnapshot: Map<storeName, rows[]>` 与
`touchedStores: Set<storeName>`。每次 `put` / `delete` 通过 `ensureStoreSnapshot(name)`
检查 `touchedStores`：首次 mutation 时调用 `db.getAll(name)` + `structuredClone` 把当前
rows 抓进 `idbSnapshot` 并把 name 加进 set，后续 mutation 命中 set 直接跳过。回滚只
clear + refill `touchedStores` 中的 object store，未触碰的 store 完全不动 —— 因此事务
开启后落入未触碰 store 的并发写入不会被 rollback 覆盖。

- Files: `packages/store/src/indexeddb/idb-store.ts` (wires `withTransaction`),
  `packages/store/src/indexeddb/idb-transaction.ts` (internal snapshot primitive)
- Runtime environment: browser IndexedDB plus `fake-indexeddb` polyfill
  for tests.

### PgStore

`postgres.js` is a connection pool, so a bare `unsafe('BEGIN')` does not bind to a
specific connection. `withTransaction` uses Drizzle's native
`db.transaction(async (tx) => …)`, which reserves a dedicated pooled connection
for the callback and issues BEGIN/COMMIT/ROLLBACK correctly. The tx-scoped store
view routes every write to that connection, so concurrent `withTransaction` calls
run on independent connections — true parallel transactions.

- File: `packages/store/src/postgres/pg-store.ts`

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

Turn commit (`packages/runtime/src/commit/session-commit-pipeline.ts`) runs the
whole proposal chain inside a single `withTransaction` callback whenever the
underlying store implements it, so a mid-chain failure auto-rolls-back and leaves
no partial state. `packages/runtime/src/session/session-kernel.ts` remains the
public facade for processing runtime results. Store adapters that do not expose
`withTransaction` still execute proposals sequentially and warn on partial commit
failure.

```ts
if (typeof store.withTransaction === "function") {
  return store.withTransaction(async (tx) => {
    // apply every proposal in order through `tx`
    return applyProposals(tx, proposals);
  });
}
// Non-transactional fallback for stores that lack withTransaction.
```

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

Table + index DDL is derived from the Drizzle schema
(`packages/store/src/{sqlite,postgres}/schema.ts`) via
`packages/store/src/common/ddl-codegen.ts`, using `CREATE TABLE IF NOT EXISTS`
and additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` so fresh installs and
existing databases both boot. The store package does **not** ship destructive
auto-migrations — when a constraint becomes stricter (e.g. `media_refs UNIQUE`
was widened from `(session_id, media_id, plugin_id)` to `(session_id, media_id)`
to fix NULL-pluginId duplicate rows; see
[`media-store.md`](./media-store.md#ownership)), the DDL still creates the new
index, but operators with legacy duplicates must run a one-off cleanup SQL before
the new index can be applied. Each such migration is documented next to the
affected table in the relevant reference doc.

## References

- Contract type: `packages/store/src/types.ts` (`DataStore` interface)
- Contract tests: `packages/store/src/contract/store-contract.ts` and `packages/store/src/contract/suites/`
- `withTransaction` nesting guard: `packages/store/src/tx-nesting-guard.ts` (Node-only AsyncLocalStorage) and `packages/store/src/tx-nesting-error.ts` (browser-safe error builder)
- Kernel commit path: `packages/runtime/src/commit/session-commit-pipeline.ts`, `packages/runtime/src/commit/session-commit-handlers.ts`
- MediaStore schema: [`media-store.md`](./media-store.md)

```

```
