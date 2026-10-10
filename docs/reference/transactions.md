# Store Transactions

> Covel's `DataStore` interface exposes a single scoped transaction contract —
> `withTransaction(fn)` — that every backend must honor. This document captures
> the contract, the per-backend implementation strategy, and how the kernel uses
> transactional commits required by every DataStore backend.

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
   * Required for every DataStore, including test doubles used by the
   * execution finalizer.
   */
  withTransaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T>;
}

type StoreTransaction = Omit<DataStore, "withTransaction" | "close"> & {
  /**
   * Run `fn` in a savepoint nested in the open transaction. A throw rolls back
   * only the writes made inside `fn` and rethrows; the enclosing transaction
   * stays open. Provided by every bundled backend's transaction scope.
   */
  savepoint?<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T>;
};
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
5. **Nesting is rejected** on every backend (see below). Use `tx.savepoint`
   for a nested rollback scope: SQLite issues `SAVEPOINT` / `ROLLBACK TO` on the
   single connection, PostgreSQL opens a Drizzle nested transaction (a savepoint
   on the reserved connection), and MemoryStore keeps one lazy snapshot per open
   savepoint level.

Ordinary `addMessage` inserts reject an occupied global message ID, including
when another session owns it. Rejection never updates the original row. If the
error escapes the transaction callback, earlier writes roll back; a failed
savepoint rolls back only its own writes. The distinct `commitPlayerInputMessage`
API retains its explicit idempotent adoption contract.

A same-owner snapshot refresh updates its capture time and payload in the same
write and follows the surrounding transaction's commit or rollback. It does not
change the snapshot ID or weaken cross-session ownership rejection.

Snapshot, suspension, and world-data import ledger IDs have one session owner.
Upserting an existing ID for another session throws
`SessionRecordScopeConflictError` on every backend without changing the original
record. SQL backends enforce ownership in the atomic conflict update, including
concurrent first inserts. A ledger batch with any ownership conflict rolls back
the entire batch; the error also rolls back a surrounding store transaction.

History compaction through `history.compact@2` uses one transaction for selective
summary deletion, replacement-summary insertion, source-message tagging, and
retagging of messages belonging to replaced summaries. `deleteSessionSummaries`
accepts an optional summary-ID list; `retagCompactedTurnMessages` accepts an
optional source-summary-ID list. An empty list changes no rows, and omitting the
list selects all summaries or all compacted messages in that session. The
compactor always passes explicit IDs, preserves retained segments, and checks
that summaries did not change while the provider generated its result. Replacing
an old prefix retains its earliest summary ID and timestamp, preserving the
ordering used when only uncompacted raw history is loaded. Original source text
remains stored. Failure of any write rolls back the whole replacement.

### Contract tests

`packages/store/src/contract/store-contract.ts` runs the shared behavioral
suite (`contract/suites/integrity-suites.ts`, `withTransaction` group) that every
backend must pass:

- `commits all writes when the callback resolves`
- `rolls back all writes and rethrows when the callback throws`
- `returns the callback result`
- `does not swallow writes across concurrent transactions`
- `rolls back only the failing concurrent transaction`
- `rolls back only a failed savepoint and keeps the enclosing transaction`
- `rolls back savepoint writes with the enclosing transaction`
- `does not expose writes through the root store before the transaction settles`
- `rejects a nested withTransaction with a clear error instead of deadlocking`
- `recovers and accepts a fresh withTransaction after a nested rejection`

Any new store backend MUST pass this suite.

## Versioned plugin-data batch CAS

Versioned domain records use a host-owned `PluginDataStore` primitive, available
on both root `DataStore` and transaction-bound views:

```ts
compareAndSetPluginDataBatch(
  sessionId: string,
  pluginId: string,
  records: readonly {
    namespace: string;
    key: string;
    expectedVersion: number | null;
    value: unknown;
    timestamp: string;
  }[],
): Promise<boolean>;
```

`expectedVersion: null` requires absence; a positive integer must exactly match
the existing JSON record's `value.version`. All comparisons succeed before any
row changes. A conflict returns `false` with no writes; invalid or duplicate
(namespace, key) entries and infrastructure failures throw. An enclosing
transaction still owns rollback of every other write. This is not a new table,
a generic JSON merge API, or a permission to write another plugin's partition.

Every backend requires an existing parent session, including for an empty batch
used as a write barrier. A missing or deleted session throws
`SessionNotFoundError` (`code: session_not_found`) without creating orphan rows.

- Memory compares and replaces the batch under its serialized store boundary.
- SQLite uses `BEGIN IMMEDIATE` when it owns the transaction; a caller's
  transaction is reused, not nested.
- PostgreSQL acquires the parent session row with `FOR UPDATE` inside the
  transaction before comparisons and writes. The lock remains held through
  the caller's ledger/receipt writes; a read followed by ordinary upsert, or
  an in-process session lock alone, is not CAS.
- BrowserVault keeps its existing atomic checkpoint/revision contract, not an
  IndexedDB implementation of `DataStore`. Checkpoints retain adopted
  dimension records, versions, source references and settlement receipts.

Dimension initialization, updates and imports use this primitive. The shared
schema/value validator runs again at the commit boundary; generic
`plugin.data`/batch/delete paths cannot write `_dimensions` or
`_dimension-settlements`. All read versions, including evaluated dimensions
whose values do not change, must still match before a successful settlement.

### Dimension settlement and execution atomicity

The host registers an obligation in the committed narrative's transaction,
using the authoritative result ID and logical turn number. Frozen definitions
and read versions live in the receipt; narrative text is read from the source
turn artifact rather than copied into every receipt. Updated values and the
success receipt commit in one CAS batch/transaction. Explicit `no-change` also
validates the read set and writes a receipt; it is not inferred from a missing
tool call or a successful runtime.

Initialization has one write path: its own `dimension.initialize` proposal. It
passes `PreStateCommit` like any other proposal and commits inside the
savepoint of the runtime that proposed it, so a veto writes nothing, a rewrite
writes the rewritten definition, and a runtime that is dropped takes its
initialization with it. Before any runtime commits, `finalizeExecution` only
binds the session to its dimension provider. Receipts freeze the committed
records: they are registered where a provider runtime first needs one (before
its first settlement update) and once more after the last runtime. A receipt
registered inside a savepoint that rolls back is registered again from what did
commit, and no receipt is registered when no committed dimension has a rule.

A rejected tracked plan can retain the story with an explicit
`pending-settlement` domain result: it writes no values and no success receipt.
This does **not** change how `finalizeExecution` treats a `committed:false`
proposal: it drops the runtime that proposed it when the execution has a
committed story, and rolls back the whole execution otherwise. Ordinary manual
version conflicts remain write rejection; infrastructure errors still throw
and roll back. Notifications are published only after durable commit. The next
narrative is blocked until the pending source is retried, explicitly marked
`manual`, or explicitly `skipped`; a plain value edit does not resolve it.

Receipts and adopted definitions/values follow existing snapshot, fork and
browser checkpoint paths. Terminal sources are not settled again after restore
or retry. See [World Model](world-model.md#回合时序与结算回执) for the five states
and [API](api.md#维度编辑与待结算恢复) for editor/tracker RPC boundaries. Old raw
dimension worlds and development sessions/checkpoints must be recreated; no
legacy read or dimension-to-lorebook double write is maintained.

## Backend implementations

An execution veto or cancellation captured in the prepared commit plan rejects
finalization before the domain transaction. Caller `extraInTx` writes, buffered
proposals, journal entries, suspensions, exports, snapshots, and successful
completion events are suppressed. Previously recorded execution history is
settled as failed; already durable client input remains outside this boundary.

Story completion is a commit precondition: a failed `outputKind: story` runtime,
a successful story result without non-empty sanitized `narrativeOutput`, or a
story the executor held back because the dimension provider failed in the same
execution (`dimension-snapshot-unavailable`) rejects execution finalization
before any buffered proposals, journal messages, or player-turn counters
commit. A story skipped for any other reason (its guard, a declared gate) does
not reject the execution. Already durable client messages remain outside
this transaction. A story runtime is not offered `runtime-done`; a model that
calls it from habit is first asked for the narrative with the remaining bounded
model steps; an empty result becomes a failed runtime. This
does not retry or reverse external tool side effects. Optional system extractors
can still fail after a valid story; their failure does not discard the story.

### MemoryStore

Two-phase snapshot using a **shallow reference copy** of each collection
(`new Map(value)` / `[...value]`), not a deep clone. The transaction lazily
captures each collection on its first write, using the method-to-collection
mapping in `WRITE_METHOD_TOUCHES`. Unknown mutators conservatively capture all
collections. On rollback it restores the captured collections in place so
that any existing references the caller is holding stay valid. On commit it simply
discards the shadow.

- File: `packages/store/src/memory/transaction-methods.ts`
- Invariant: correctness relies on records being treated as **immutable** —
  mutations must replace the record (new object), never mutate in place. This
  is why an O(row-count) reference copy is safe. A deep clone is unnecessary
  under the never-mutate-in-place contract and is substantially more expensive.

### SqliteStore

Direct SQL: `sqlite.exec('BEGIN')` / `'COMMIT'` / `'ROLLBACK'`. The store is one
synchronous `node:sqlite` connection, so `withTransaction` **serializes** concurrent
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
> through one `node:sqlite` handle shares a single gate, resolved via
> `getConnectionWriteGate(db)` in `sqlite/shared-connection.ts`: the `DataStore`
> methods, the optional sqlite-vec capability (`VECTOR_WRITE_METHODS`), and the
> mirror MediaStore that deliberately reuses the same connection
> (`MEDIA_WRITE_METHODS`). Before this, only the `DataStore` methods were gated,
> so a vector or media write issued from another session still joined an open
> transaction and disappeared on its rollback.
>
> Statements were already serialized — `node:sqlite` is synchronous — but the
> gate is held for a transaction's whole callback, including its awaits. Keep
> transaction bodies to store work: the execution finalizer runs plugin
> `PreStateCommit` hooks before opening its transaction for this reason. **Per-transaction connections (as PgStore has) remain
> the long-term answer for real concurrency**; the gate closes the correctness
> gap without a store-connection rearchitecture. Regression coverage:
> `packages/store/tests/serialized-write-gate.test.ts`.

### Vector index initialization and transfer

A registered vector model guarantees its physical table exists. PostgreSQL initializes the registry row, optional vector extension, table, and indexes in one transaction, then publishes the in-process cache after commit. An advisory transaction lock serializes initialization across processes. SQLite uses an immediate transaction and reads model state directly so outer rollbacks cannot leave stale caches. Existing broken development registries must be recreated.

Snapshots, forks, and browser checkpoint transfers exclude the reserved `__kernel:vector` partition. Its ingest cursors and hashes describe a local physical index, not transferable session data. Both producers and importers apply this rule; rebuilt sessions re-index their messages and lore. Ordinary plugin data with the same namespace names is retained.

The server's shared commit entry point schedules best-effort ingestion only after
`commitExecution` reports a durable commit. Player, manual, resumed, and detached
executions use that entry point. Fork and browser checkpoint replacement also
schedule ingestion. Bootstrap establishes the configured embedding model lock
inside the ingestion lease before reading the corpus. A scheduled run continues
through bounded provider batches until the current corpus is indexed; short or
failed embeddings leave unfinished progress for a later run.

Ingestion uses its own per-session lock (advisory across PostgreSQL hosts), never
the turn lock. Lifecycle replacement and deletion acquire locks in this order:
session, world when needed, ingestion, then storage transaction. They wait for
all delayed vectors, cursor updates, hash updates, and archival deletions before
replacing or deleting state, including checkpoints that retain `createdAt`.
Ordinary turns can commit while embeddings run; the ingestor coalesces another
pass to observe those commits. Shutdown drains tracked memory tasks before
closing storage. Embedding failures do not change the committed turn outcome.

Fork preserves character IDs because every backend keys characters by
`(sessionId, id)`. Copied plugin references and the child's snapshot therefore
identify the same characters as the child store.

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
- deleting a browser world atomically removes its associated checkpoints,
  commit metadata and pending commits; owned session mirrors are cleaned up
  best-effort, without deleting the shared server world;
- world edits and local checkpoint writes use the current browser world record,
  so an older session checkpoint cannot undo a saved edit;
- `baseRevision`, `revision`, and `actionId` reject stale or divergent writes;
- browser checkpoint upload/download operations are serialized by
  `LocalDataService`. It owns durable pending-commit recovery before hydration
  or staging a different action. A missing transient session clears the pending
  marker and allows rebuilding from the browser checkpoint; other errors retain
  the marker and block newer commits;
- checkpoint export reads runtime results once per session using
  `listRuntimeResults(sessionId)`. Omitting `turnId` returns all session rows,
  including interrupted executions without a turn-result row; passing `turnId`
  retains the existing per-turn filter on every backend;
- the transient server workspace uses `MemoryStore.withTransaction` when a
  checkpoint replaces a session;
- checkpoint imports validate every record's structure and session scope,
  including snapshot payloads, before entering the write transaction;
- trusted fork copies use `rebindSnapshotPayloadSession` to bind nested state
  to the child session; exports normalize legacy fork payloads before wire
  validation. External checkpoint input is never rebound to bypass ownership
  checks;
- `replaceSessionFromCheckpoint` preserves global worlds by default. Callers
  must explicitly opt into `writeWorld` after independently authorizing global
  writes; session ownership alone does not authorize a shared-world update;
- upload and commit routes recheck owner, incarnation and deletion status
  under the session lock before using revision or idempotency caches. Cache
  entries belong to one incarnation and are discarded after same-id recreation.

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
  （`actions.ts` / `plugin-rpc/runtime-turn.ts` / `resume.ts`）将公开执行入口返回的
  `{ result, commit }` 整体交给 `commitExecution({ execution, ... })`。提交计划捕获执行时
  的 schema、Hook 设置、journal、suspension 和嵌套结果；宿主不再重新加载 schema 或
  手工组装这些字段。缺失已声明导出的 schema 使整次事务失败。
  `commitExecution`
  进入这个边界，再由同一宿主入口协调通知、快照和记忆调度。

`start_session` 带 `loreOverride` 时，服务端先把它写进会话 metadata，再进入回合事务，所以它不属于回合事务：随后的回合失败不会撤销这次写入。这是有意的，使后续回合和其他实例看到同一份世界背景快照。

`/api/actions` 的 `onFinalized` 仅依据durable outcome结算宿主标记并入观察队列，不等待SSE消费；自动snapshot仍在同一session lock内执行。写入错误、队列溢出、观察截止与锁外drain失败不能把committed artifact改成failed，不能开放同turn恢复重放，也不能重试模型。恢复以durable artifact和只读execution/session端点为准，而不是是否收到最后一帧。

> **回合级单事务**：`finalizeExecution` 把整回合所有 runtime（含嵌套
> `recursiveCall` 结果）聚合进单一事务：
>
> - **叙事优先的失败边界**——领域写入抛出的 store 错误使整回合回滚。handler 校验失败返回
>   的 `{ committed: false }`（如 PreStateCommit veto、缺字段的 state.patch）在本次执
>   行有成功的 story 结果时，只回滚提出它的那个可选 runtime：每个非 story、非 setup
>   的 runtime 在自己的 savepoint 内提交，被拒绝时只撤销它自己的写入，叙事与其他
>   runtime 照常提交，`FinalizeExecutionOutcome` 以 `committed` 返回并在
>   `failedProposals` / `isolatedRuntimes`（`{ runtimeId, error }`）中列出被丢弃的部分
>   （主回合以 `proposal.failed` 与该 runtime 的 `runtime.failed` SSE 告知）。没有 story
>   的执行（manual、background、detached、setup）仍是整体原子：任一 proposal 失败即整体
>   回滚，作业不会为未落库的写入报告成功。结果里无法变成 proposal 的 effect 条目
>   （`effects.ui[].parts`、`effects.interactions`、`effects.notifications`、`effects.statePatches` 中的非对象，以及后三个通道的非数组内容）
>   同样算作该 runtime 被拒绝的写入，按上述边界处理，不会以异常拖垮整回合；function
>   runtime 在 handler 返回时就以 `output-schema-invalid` 失败。
> - **导出发布的独立失败边界**——每个 `recordAs` export 的读取、序号分配与追加放在一个 savepoint 中。单个 export 的存储失败先回滚该 savepoint，再记录诊断并继续其他 export 与领域提交；PostgreSQL 不会把已捕获的 SQL 错误留在 aborted transaction 中。缺失声明 schema 和公共输出契约校验失败仍在正常执行校验边界处理。
> - **只有上游真正提交，下游才提交**——结果按执行顺序提交，被丢弃 runtime 的硬依赖方
>   一并丢弃（`commit/commit-dependencies.ts`）：turn 作用域的 `needs` 目标、必填
>   `inputs` 来源，以及触发事件的全部发出者都被丢弃的事件订阅者。`after` 与
>   `required: false` 的输入只表达顺序或尽力读取，不级联；`cardinality: one` 的能力依赖
>   在另有提供者提交成功时仍满足。story 或 setup runtime 的硬上游被丢弃时整回合回滚。
>   `extraInTx` 的第二个参数给出被丢弃的 runtime，主回合据此不排入依赖它们的 detached
>   作业与后台事件 follower；仍排入的 detached 作业在冻结的 turn digest 与上游结果中把被丢弃的 runtime 记为 `failed`。
> - **PreStateCommit 在事务外运行**：finalize 先完成规范化、守卫和 PreStateCommit
>   Hook，再开启事务，事务内只做写入；`createCommitPipeline().commitAll` 同理。Hook
>   不读取存储状态，提前运行不改变语义，但插件 Hook 的等待不再占用 SQLite / Memory
>   的串行门。
> - **玩家停止与提交共享边界**：`finalizeExecution` 接受可选 `signal`，在事务开始、结果处理及返回前检查取消，并传递到每个提案的 `PreStateCommit` Hook。取消会立即结束 Hook 等待、停止后续提案并整体回滚。主回合传入玩家控制信号；即使剧情已生成、取消发生在后处理或提交 Hook 中，事务仍整体回滚。数据库已提交后的通知和 `PostStateCommit` Hook 不继承这个取消信号，按自身超时完成收尾。
> - **对话 execution journal 共享提交命运**：当前玩家输入与非 manual runtime 的
>   `TurnMessage` 在执行期只缓存在内存 journal；所有 proposal 通过后才由
>   `finalizeExecution` 在同一事务中 append。回滚执行不会进入后续 Prompt、trigger
>   统计或 compaction。`actions.ts` 同时通过 `extraInTx` 提交 REST messages 镜像与
>   player InteractionRecord，刷新和观测面也不会保留回滚输入。manual/background 路径
>   继续遵循各自不追加对话历史的合同。
> - `turn_results.commit_status` 在同一事务内于成功时结算为 `committed`；回滚时在
>   事务外幂等结算为 `failed`。嵌套 recursiveCall 复用顶层 `turnId`，因此顶层的
>   `[turnId]` 一次结算即覆盖所有嵌套行。`committed` 结算同时把被丢弃 runtime 在
>   `runtimeResults` 中的记录改为 `failed` 并写入原因，历史、重试与刷新看到的都是
>   实际保存的结果；它们上报的 job 也收尾为 `failed`。和其他失败的 runtime 一样，被丢弃的
>   runtime 不写入对话日志（文本、交互与 UI 卡片），也不计入触发台账
>   （`maxTriggerCount` / `cooldownTurns`）。
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
>   current-only 时钟字段。整回合回滚时（story 或 setup 失败，或没有 story 的执行中
>   任一 proposal 失败）计数、phase、setup 镜像都不推进，ledger 不写入；只丢弃可选
>   runtime 的提交照常推进时钟。manual / background finalize 不传 `sessionClock`，
>   时钟不动。resume 传入：同一逻辑回合最后一个 suspension 恢复时计数一次；被恢复的
>   是 setup runtime 且报告完成时，`done` 镜像与（全部 setup 完成时的）phase 翻转
>   随这次提交写入，attempt 账本沿用挂起时的那次尝试。
> - **Action 级 plugin-rpc 锁边界**：action handler 在 session lock 内完成读、校验和写入；
>   `framework.submit-form` 再用 store transaction 原子提交批量 player input。因而同一 session
>   的 turn 与重复表单提交不会穿插，PG 多进程部署也由同一分布式锁键串行化。
>
> **必需事务**：`finalizeExecution` 要求完整 DataStore，直接调用 `withTransaction`，
> 不提供无事务回合提交的降级。底层 `commitAll` 接收到 `StoreTransaction` 视图时不再开
> 嵌套事务，而是复用调用方的事务；这个分支不代表完整 DataStore 可以省略事务实现。
>
> 注意 fork（`snapshots.ts`）仍是独立的会话重建事务：它重放快照、**不提交任何
> proposal**，因此不经 `finalizeExecution`——两者共享"一个 `withTransaction` 包住整个
> 写入序列"的模式，但属于不同关注点。

```ts
// finalizeExecution: normalization, guards and PreStateCommit run first.
const prepared = new Map();
for (const result of results) {
  prepared.set(
    result,
    await prepareRuntimeProposals(
      result,
      store,
      sessionId,
      kindOf(result),
      opts,
    ),
  );
}
// All runtime results then share one required transaction, which only writes.
await store.withTransaction(async (tx) => {
  for (const result of results) {
    const { proposals, failedProposals } = prepared.get(result);
    const commit = async (sink) => {
      const out = await commitPreparedProposals(
        proposals,
        sink,
        sessionId,
        result,
        opts,
      );
      const failed = [...failedProposals, ...out.failedProposals];
      if (failed.length > 0) throw new ProposalCommitFailure(failed);
    };
    // An optional runtime beside a committed story commits in its own
    // savepoint; a ProposalCommitFailure there drops that runtime alone.
    await (isolates(result) ? tx.savepoint(commit) : commit(tx));
  }
  for (const message of journalMessages) await tx.appendTurnMessage(message);
  await extraInTx?.(tx, { droppedRuntimeIds });
  for (const turnId of turnIds) {
    await tx.setTurnResultCommitStatus(
      sessionId,
      turnId,
      "committed",
      droppedRuntimes,
    );
  }
});
// Flush buffered notifications only after COMMIT; discard them on rollback.
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
`force` sync. Dimension declarations also enter the ledger, including inline
and external declarations and stored worlds. An unchanged declaration preserves
progress; a new declaration initializes its value. Changing or removing a
record that has evolved or been edited, or has pending settlement, produces a
conflict. `force` does not bypass those dimension protections or migrate values
to a new schema. Apply rechecks ledger hashes and record versions in its
transaction; conflicts preserve the existing definition/value/version. A row in
conflict is reported and left alone; it does not hold back the other rows of
the sync.

Media bytes live in `MediaStore`, which has a separate lifecycle from
`DataStore`. World-data import validates media during preflight, writes the
media object and a unique temporary reference atomically before the session-store
media index row, and rolls back the `DataStore` transaction on failure. The
reference protects unpublished bytes from concurrent GC. Finalization establishes
session claims before releasing the temporary reference; failed preparation or
publication releases only that attempt's temporary references. Sync deletion of
importer-managed media index rows removes only the current session's explicit
media ref. Lifecycle GC reclaims bytes after all ownership/ref claims are gone.
Temporary-reference release failures are logged without masking the import
outcome. Crashes may leave conservative pins that require operator cleanup;
there is no automatic expiry or schema migration. If semantic data has committed
but media finalization fails, temporary references remain to protect that data;
creation rollback only releases them after the session deletion succeeds.

### Observability

Transactional commits produce the same `trace_events` as non-transactional
commits (proposal apply, commit success/failure). The trace does not currently
add a dedicated transaction-mode field; inspect the active store backend when
debugging whether a run used transactions.

## Schema changes

Table + index DDL is derived from the Drizzle schema
(`packages/store/src/{sqlite,postgres}/schema.ts`) via
`packages/store/src/common/ddl-codegen.ts`, using `CREATE TABLE IF NOT EXISTS`.
During early development the stores do not migrate old data: a database made by
an earlier build boots only when its tables already match, and a change to a
table, a constraint or an index that old rows do not satisfy is listed under
Breaking in `docs/CHANGELOG.md` with the development data to recreate. At start
the stores delete retired tables and retired plugin-data namespaces; that is a
removal, not a conversion.

## References

- Contract type: `packages/store/src/types.ts` (`DataStore` interface)
- Contract tests: `packages/store/src/contract/store-contract.ts` and `packages/store/src/contract/suites/`
- `withTransaction` nesting guard: `packages/store/src/tx-nesting-guard.ts` (Node-only AsyncLocalStorage) and `packages/store/src/tx-nesting-error.ts` (browser-safe error builder)
- Kernel commit path: `packages/runtime/src/commit/session-commit-pipeline.ts`, `packages/runtime/src/commit/session-commit-handlers.ts`
- MediaStore schema: [`media-store.md`](./media-store.md)

## World data 写入的一致性边界

- **`POST /worlds/:id/sync-dimensions`** — 只同步维度账本与受保护 `_dimensions` 记录，在 **SessionLock + store transaction** 中重新验证并应用；不重建 `entries` 或 Lorebook。已演化/手改或待结算的维度保持原样并列在冲突报告里，其余维度照常写入；存储异常整体回滚并返回 500。
- **`POST /worlds/:id/sync-data`** — 冲突扫描在事务外进行（需要读文件系统的世界包），因此 apply transaction 内会对每个待覆盖目标**重读 hash 做 CAS**：扫描后被改动过就整体中止，返回 `409 { code: "world_data_sync_conflict" }`。调用方重跑，新扫描将改动报为正常 conflict；普通领域可显式 `force`，维度的已演化/待结算保护不因此解除。维度使用 batch CAS 并持有会话写屏障；路由同时持 SessionLock，挡住回合并发写。
- **媒体与 DataStore 分属不同生命周期**。session create 和 sync 在语义事务前准备媒体，`put` 原子建立本次导入专属临时引用。发布成功先建立 session claims 再释放临时引用；提交前失败只释放本次临时引用，无归属字节交给 GC，不强制删除内容。提交后 finalization 失败则保留保护，创建回滚成功删除会话后才可释放。兼容调用入口若在 DataStore 事务内 materialize，也遵守同一引用规则。进程崩溃可能留下无自动过期的临时引用，需确认导入已停止后人工清理。
- **Compactor** 的 summary 写入与 message tag 在同一 transaction 内：只写 summary 会产生 orphan——`message-insertion` 会把它当 system message 发出，而未打 tag 的原始历史仍然注入，形成双份上下文。

记忆抽取使用通用 detached runtime 作业。故事提交事务同时保存 `turn-digest@1` 和作业记录，凭据仅保留在进程内交接表；登记后事务失败必须清理对应凭据。Worker 将插件块的 proposal 与作业完成回执放在同一事务里提交。

`completion.settle: before-next-execution` 在下一次执行入口等待这些作业。等待时不持 SessionLock，取得锁后再次检查；超过声明的等待预算会记录 trace 并继续。取消请求只中止等待。相同 session/runtime 的作业按源回合顺序处理，失败和超时作为终态放行，显式重试不会覆盖更新的源回合作业。进程崩溃后已 claim 的抽取不自动重放，避免重复调用和旧内容覆盖。

原请求服务优先，其次使用可用的服务端配置；只有请求头凭据的部署由后续授权请求补交服务。队列与快照不保存 API key。凭据表是进程内状态，不提供跨实例原请求优先保证。服务关闭停止 claim、取消尚未进入提交的任务，并等待 worker 持有的存储操作释放；已进入提交的事务允许完成。这不保证所有记忆提取成功排空。向量摄取仍是独立路径。

## Derived vector-index progress

Embedding ingestion uses bounded batches and caps each input text. An explicit content-local rejection is bisected until the offending entry is isolated; that entry advances the cursor without a vector so later entries can proceed. Authentication, unknown and transient failures do not permanently skip entries. Archive replacements remove stale vectors even when the new content cannot be embedded.

`VectorStoreCapability` exposes `getVectorIndexProgress(scope)` and
`commitVectorIndexBatch(input)` for atomic vector and index-progress writes.
Scope is `(sessionId, pluginId, namespace)`. Updates require both the previously
read serialized value (`null` means absent) and `expectedSessionCreatedAt`.
A batch may include `deletes` (namespace/key pairs) and `upserts`
(namespace/key/embedding/payload), scoped to the same session and plugin. The
progress namespace identifies the cursor or hash map; each vector mutation names
its own data namespace. Deletes run before upserts, and all mutations commit with
the new progress value. A CAS conflict returns `false` without changing vectors
or progress; a stale or missing session incarnation or any invalid mutation
throws and rolls back the entire batch.
PostgreSQL holds the parent session row with `FOR KEY SHARE`, while SQLite uses
an immediate transaction and Memory uses its serialized store boundary. These
operations do not run on the `StoreTransaction` business-data view.

Progress belongs to `vector_index_progress`, not `plugin_data`. Session cascade
deletion clears it in the same transaction as the session; rolling back that
cascade restores it. Snapshot/checkpoint export omits it by construction, so
restored or forked sessions rebuild indexes from their own source rows.

`deleteVectors` optionally accepts `key` to remove one entry within the selected
scope and `expectedSessionCreatedAt` to reject stale asynchronous deletions.
Ingestion reads all archival sources and completes embedding before submitting
the corresponding deletes, upserts, and progress as one batch. An older sweep
cannot overwrite the vectors owned by a newer progress value. Optional
cross-process ingestion locks reduce duplicate embedding work; correctness does
not depend on them. Embedding provider calls never run inside the index commit
transaction or a business-data transaction.

World-data import and sync resolve locale overlays before planning any writes. Source `localeArrayKeys` provide nested list identities (after `key` and `id`), so translated records keep their association when the authored list is reordered.
