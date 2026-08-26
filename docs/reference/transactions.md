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
- `does not expose writes through the root store before the transaction settles`
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
  is why an O(row-count) reference copy is safe. A deep clone is unnecessary
  under the never-mutate-in-place contract and is substantially more expensive.

### SqliteStore

Direct SQL: `sqlite.exec('BEGIN')` / `'COMMIT'` / `'ROLLBACK'`. better-sqlite3 is
a single synchronous connection, so `withTransaction` **serializes** concurrent
calls through a promise chain — each runs its full BEGIN…COMMIT before the next
starts, so neither loses writes.

- File: `packages/store/src/sqlite/sqlite-transactions.ts`

### PgStore

`postgres.js` is a connection pool, so a bare `unsafe('BEGIN')` does not bind to a
specific connection. `withTransaction` uses Drizzle's native
`db.transaction(async (tx) => …)`, which reserves a dedicated pooled connection
for the callback and issues BEGIN/COMMIT/ROLLBACK correctly. The tx-scoped store
view routes every write to that connection, so concurrent `withTransaction` calls
run on independent connections — true parallel transactions.

- File: `packages/store/src/postgres/pg-store.ts`

### Cross-backend semantics (read before adopting)

The three backends honor the same observable contract (atomic commit / rollback,
nested-call rejection) but differ in concurrency and isolation:

| Backend                       | Concurrency model                                                                                                                   | Concurrent root operation during a callback                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **PgStore**                   | Each call runs on its **own pooled connection** (Drizzle `db.transaction`) — true parallel transactions.                            | Reads observe their database snapshot; writes stay on their own connection and are not folded in.                              |
| **SqliteStore / MemoryStore** | **Single connection / live state.** Transactions and every root read/write share one promise queue (**serialized operation gate**). | **Queued until the transaction settles** — no dirty read and no folded write. Operations issued through `tx` still run inline. |

> **Serialized operation gate (SQLite / Memory).** One connection/live state
> means a transaction cannot isolate by itself: a write issued elsewhere while
> a transaction is open used to land inside it, while an outside read could see
> data that was later rolled back. The session lock orders writes belonging to one session's turn, but
> it is per-session and some routes hold no session lock at all (world imports,
> character edits, settings), so a write from another session could vanish.
> `packages/store/src/serialized-write-gate.ts` puts transactions and all root
> store operations on **one queue**: outside reads/writes wait for the
> transaction; operations through the `tx` scope run
> inline (it belongs to that transaction, and queueing it would deadlock).
> Inside vs outside is decided by `AsyncLocalStorage`, so a genuinely concurrent
> caller that starts while a transaction is suspended at an `await` is not
> mistaken for a nested one.
>
> **The gate is per-connection, not per-store.** Everything that mutates
> through one better-sqlite3 handle shares a single gate, resolved via
> `getConnectionWriteGate(db)` in `sqlite/shared-connection.ts`: the `DataStore`
> methods, the optional sqlite-vec capability (`VECTOR_WRITE_METHODS`), and the
> mirror MediaStore that deliberately reuses the same connection
> (`MEDIA_WRITE_METHODS`). Before this, only the `DataStore` methods were gated,
> so a vector or media write issued from another session still joined an open
> transaction and disappeared on its rollback.
>
> Throughput is unaffected — better-sqlite3 is synchronous, so its statements
> were already serialized. **Per-transaction connections (as PgStore has) remain
> the long-term answer for real concurrency**; the gate closes the correctness
> gap without a store-connection rearchitecture. Regression coverage:
> `packages/store/tests/serialized-write-gate.test.ts`.

### MediaStore transaction and concurrency fixes

Media lifecycle mutations use per-resource atomicity alongside the DataStore
transactions:

- SQLite/local-fs cleanup performs its final owner/reference check and asset
  deletion inside `BEGIN IMMEDIATE`. Its MediaStore shares the DataStore
  connection gate, so a concurrent transaction cannot absorb or lose a media
  write on rollback. Cleanup reports only assets actually deleted.
- PostgreSQL `put`, ownership, reference, deletion, and cleanup operations use
  a transaction-scoped advisory lock keyed by content id. This serializes
  first-writer-wins and reference/deletion races across processes; cleanup also
  uses `NOT EXISTS` in the guarded delete.
- IndexedDB MediaStore keeps ownership and reference updates atomic in its
  object-store transactions. It is a media backend only; browser game-state
  persistence is handled by BrowserVault below, not by an IndexedDB DataStore.

### Nesting is rejected on every backend

Calling `withTransaction` from inside another `withTransaction` callback is a
programming error and is **rejected synchronously with a clear error** on all
three backends:

- **Serialized backends (SQLite / Memory):** the inner call would
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
  The shared error builder lives in `packages/store/src/tx-nesting-error.ts`.
  The AsyncLocalStorage guard is Node-only because all `DataStore` backends run
  on the server.

## BrowserVault transactions

Browser-private persistence is deliberately outside `DataStore`. Dexie owns
the IndexedDB transaction and schema lifecycle in
`apps/web/src/services/storage/browser-vault.ts`:

- a checkpoint and its compact action-idempotency row commit in one `rw`
  transaction;
- only the latest full checkpoint is retained;
- `baseRevision`, `revision`, and `actionId` reject stale or divergent writes;
- browser checkpoint upload/download operations are serialized by
  `LocalDataService`;
- the transient server workspace uses `MemoryStore.withTransaction` when a
  checkpoint replaces a session.

This is a synchronization contract, not an attempt to reproduce the full
server transaction API in the browser.

## Kernel integration

两层事务边界：

- `commitAll`（`packages/runtime/src/commit/session-commit-pipeline.ts`）把
  **单个 runtime** 的 proposal chain 提交进一个 `withTransaction` 回调。它仍是
  最底层的提交原语。
- `finalizeExecution`（`packages/runtime/src/commit/finalize-execution.ts`）把
  **整个 execution**——顶层结果加上拍平后的嵌套 `recursiveCall` 结果——的所有
  runtime 一起包进 **一个** `withTransaction`。三个提交拥有方
  （`actions.ts` / `plugin-rpc/runtime-turn.ts` / `resume.ts`）现在都经它收口，
  不再手写逐 runtime 的提交循环。

> **回合级单事务**：`finalizeExecution` 把整回合所有 runtime（含嵌套
> `recursiveCall` 结果）聚合进单一事务：
>
> - **任一 proposal 失败即整回合回滚**——无论是抛出的 store 错误，还是 handler 校验
>   失败返回的 `{ committed: false }`（如 PreStateCommit veto、缺字段的 state.patch）。
>   已提交的兄弟 runtime 一并回滚，事务外不留痕迹。
> - **对话 execution journal 共享提交命运**：当前玩家输入与非 manual runtime 的
>   `TurnMessage` 在执行期只缓存在内存 journal；所有 proposal 通过后才由
>   `finalizeExecution` 在同一事务中 append。回滚执行不会进入后续 Prompt、trigger
>   统计或 compaction。`actions.ts` 同时通过 `extraInTx` 提交 REST messages 镜像与
>   player InteractionRecord，刷新和观测面也不会保留回滚输入。manual/background 路径
>   继续遵循各自不追加对话历史的合同。
> - `turn_results.commit_status` 在同一事务内于成功时结算为 `committed`；回滚时在
>   事务外幂等结算为 `failed`。嵌套 recursiveCall 复用顶层 `turnId`，因此顶层的
>   `[turnId]` 一次结算即覆盖所有嵌套行。
> - **完成屏障仍被扣留**：任一失败时 `turn.completed`、回合后记忆摄入、auto-snapshot
>   都不触发，每个失败 proposal 发出 `proposal.failed` 事件，回合对客户端呈现为可见
>   的未完成态而非"成功但状态缺失"。
> - **外部可见的 fan-out**（emitter 事件 + PostStateCommit hook）在事务开启期间缓冲，
>   仅在 COMMIT 之后按序 flush；回滚连缓冲一并丢弃，客户端绝不会看到已回滚写入的
>   "committed" 事件。
> - resume 通过 `extraInTx` 把助手回合消息与 suspension resolved 标记折叠进同一事务，
>   任一失败连同 proposal 一起回滚，claim 释放后可重试。
> - **会话时钟写入进同一事务（调度重构 W3b，2026-07-22）**：玩家路径（`actions.ts`）
>   通过 `sessionClock` 参数把逻辑回合计数（`completedPlayerTurns` 的 logical-turn
>   ledger 幂等推进）与 setup 频段翻转（`phase: setup → playing` + `setupRuntimes`
>   镜像）折叠进 proposal 提交后、`commit_status` 结算前的同一事务（
>   `commit/session-clock.ts` 的 `applySessionClockTx`）。API 与 snapshot 直接保存
>   current-only 时钟字段。任一 proposal 失败即整体回滚——
>   计数、phase、setup 镜像都不推进，ledger 不写入。manual / background / resume
>   finalize 不传 `sessionClock`，时钟不动。
> - **Action 级 plugin-rpc 锁边界**：action handler 在 session lock 内完成读、校验和写入；
>   `framework.submit-form` 再用 store transaction 原子提交批量 player input。因而同一 session
>   的 turn 与重复表单提交不会穿插，PG 多进程部署也由同一分布式锁键串行化。
>
> **降级**：不暴露 `withTransaction` 的 store（薄测试 mock / 旧后端）退回逐条提交，
> 不承诺跨 runtime 回滚——与这些 store 一贯的尽力而为语义一致，并 warn 一次。
>
> 注意 fork（`snapshots.ts`）仍是独立的会话重建事务：它重放快照、**不提交任何
> proposal**，因此不经 `finalizeExecution`——两者共享"一个 `withTransaction` 包住整个
> 写入序列"的模式，但属于不同关注点。

```ts
// finalizeExecution: 整个 execution 的所有 runtime 结果进入单一事务。
if (typeof store.withTransaction === "function") {
  await store.withTransaction(async (tx) => {
    for (const result of results) {
      const out = await processRuntimeResult(result, tx, ...);
      if (out.failedProposals.length > 0) throw new ProposalCommitFailure(...); // → 整回合回滚
    }
    for (const message of journalMessages) await tx.appendTurnMessage(message);
    await extraInTx?.(tx); // caller 专属的事务内追加写（resume）
    for (const turnId of turnIds) await tx.setTurnResultCommitStatus(sessionId, turnId, "committed");
  });
  // COMMIT 之后才 flush 缓冲的 fan-out；回滚则丢弃。
}
// 无 withTransaction 时降级为逐条提交，不承诺跨 runtime 回滚。
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
existing databases both boot. Store-managed migrations include the lossless
character/lorebook identity change from a global `id` primary key to
`(session_id, id)`: SQLite rebuilds both tables in one transaction, PostgreSQL
changes the primary-key constraint after checking the catalog, and browser
IndexedDB v15 rebuilds both object stores in the active versionchange
transaction. Existing rows remain unchanged because the legacy global key is a
subset of the new composite key; operators should still back up durable stores
before a release migration.

Constraint changes that require data cleanup remain operator-managed. For
example, `media_refs UNIQUE` was widened from
`(session_id, media_id, plugin_id)` to `(session_id, media_id)` to fix
NULL-pluginId duplicate rows (see
[`media-store.md`](./media-store.md#ownership)). The DDL still creates the new
index, but operators with legacy duplicates must run a one-off cleanup SQL
before the new index can be applied. Each such migration is documented next to
the affected table in the relevant reference doc.

## References

- Contract type: `packages/store/src/types.ts` (`DataStore` interface)
- Contract tests: `packages/store/src/contract/store-contract.ts` and `packages/store/src/contract/suites/`
- `withTransaction` nesting guard: `packages/store/src/tx-nesting-guard.ts` (Node-only AsyncLocalStorage) and `packages/store/src/tx-nesting-error.ts` (browser-safe error builder)
- Kernel commit path: `packages/runtime/src/commit/session-commit-pipeline.ts`, `packages/runtime/src/commit/session-commit-handlers.ts`
- MediaStore schema: [`media-store.md`](./media-store.md)

## World data 写入的一致性边界

- **`POST /worlds/:id/sync-dimensions`** — 四阶段重写（删除过期 plugin-data 行 → 批量写入 → upsert lorebook → 删除过期 lorebook）在**一个 SessionLock + 一个 store transaction** 内完成。失败整体回滚并返回 500，不会让下一轮 prompt 读到「删了一半」的世界数据。
- **`POST /worlds/:id/sync-data`** — 冲突扫描在事务外进行（需要读文件系统的世界包），因此 apply transaction 内会对每个待覆盖目标**重读 hash 做 CAS**：扫描后被改动过就整体中止，返回 `409 { code: "world_data_sync_conflict" }`。调用方重跑（新扫描会把该改动报为正常 conflict）或显式 `force`。路由同时持 SessionLock，挡住回合并发写。
- **媒体副作用仍在 DB 事务内**（`deferMediaFinalize: false`）。DB 回滚无法撤销已写入的 media bytes，因此 materialize 过程使用**增量补偿栈**：每次 `put` 成功立即登记，中途失败也能清理已落盘的资产。
- **Compactor** 的 summary 写入与 message tag 在同一 transaction 内：只写 summary 会产生 orphan——`message-insertion` 会把它当 system message 发出，而未打 tag 的原始历史仍然注入，形成双份上下文。
