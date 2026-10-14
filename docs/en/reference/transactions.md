# Transactions

This page explains how Covel makes sure that "a batch of writes either all takes effect, or none of it does". It is for developers who change a storage backend, change the turn commit flow, or track down "why this write was not saved". Writing a plugin does not require this page. A plugin's writes all go through proposals, and the kernel commits them.

There are three key points:

- The storage interface `DataStore` has only one kind of transaction: `withTransaction(fn)`. Every backend must implement it.
- All writes of one execution (a turn, a manual run, or a background job) are put into one transaction and committed together.
- The three backends (Memory, SQLite, PostgreSQL) behave the same from the outside. They handle concurrency differently.

World package files are outside the database transaction. Generation, revision, and translation coordinate files and world records through staging, package preflight, directory replacement, and failure recovery; the [API write-back rules](./api.md#post-apiworldsidtranslate) describe what survives a failure.

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

Usage is simple: put the writes that must succeed or fail together into `fn`, and make every write through the `tx` that `fn` receives. A savepoint is a "section inside a transaction that can be undone on its own".

### Rules

1. **If `fn` returns normally, everything is committed. If it throws, everything is rolled back.** The writes made through `tx` are committed together. If `fn` throws, all of them are undone, and the error is passed to the caller unchanged.
2. **A rollback restores the state you can observe.** After a transaction rolls back, every read method returns the same result it returned just before the transaction started. Records that existed before keep their original identity. Changes made in the transaction are discarded.
3. **There is no shared handle.** The transaction's scope is tied only to this one `fn` call. The outer store does not stay stuck in a "transaction in progress" state, and a failed transaction does not block the store.
4. **Writes outside a transaction take effect at once.** A write method that is not called inside `withTransaction` is permanent as soon as it finishes.
5. **Nesting is not allowed.** Every backend rejects opening a transaction inside another one (see [below](#nesting-is-rejected-on-every-backend)). When you need a section that can be rolled back on its own, use `tx.savepoint`:
   - SQLite runs `SAVEPOINT` / `ROLLBACK TO` on its single connection.
   - PostgreSQL opens a Drizzle nested transaction, which means a savepoint on the kept connection.
   - MemoryStore keeps a lazy snapshot for each savepoint level it opens.

**Message IDs cannot repeat.** A normal `addMessage` insert rejects a global message ID that is already taken, even if another session holds it. The rejection does not change the existing row. When an error leaves a transaction callback, the earlier writes roll back. A failed savepoint rolls back only its own writes. The other method, `commitPlayerInputMessage`, keeps its own explicit "idempotent takeover" rule.

**Snapshot refresh.** When the same owner refreshes a snapshot, the capture time and the content are updated in the same write. The update follows the commit or rollback of the outer transaction. It does not change the snapshot ID, and it does not relax the rejection of cross-session ownership.

**One ID belongs to one session.** The IDs of snapshots, suspension records, and the world-data import ledger each have exactly one owning session.

- Upserting an existing ID under another session's name throws `SessionRecordScopeConflictError` on every backend, and the original record is unchanged.
- SQL backends check ownership inside an atomic conflict update. Concurrent first inserts are handled the same way.
- If any single row in a ledger batch write has an ownership conflict, the whole batch is rolled back. This error also rolls back the outer store transaction.

**History compaction is one transaction.** History compaction done through `history.compact@2` does four things in one transaction: it deletes selected summaries, inserts the replacement summary, marks the source messages, and re-marks the messages that belong to the replaced summary.

- `deleteSessionSummaries` accepts an optional list of summary IDs. `retagCompactedTurnMessages` accepts an optional list of source summary IDs.
- An empty list changes no rows. Leaving the list out selects all summaries of this session, or all compacted messages.
- The compactor always passes explicit IDs, keeps the segments it does not replace, and checks whether the summaries changed while the provider was generating its result.
- When an old prefix is replaced, the earliest summary ID and timestamp are kept. This way, the ordering used when loading only "uncompacted raw history" does not change.
- The original text of the source messages is still stored.
- If any write fails, the whole replacement is rolled back.

### Contract tests

`packages/store/src/contract/store-contract.ts` runs the behavior tests shared by all backends (the `withTransaction` group in `contract/suites/integrity-suites.ts`). Every backend must pass them:

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

A new storage backend **must** pass this suite.

## Versioned plugin-data batch CAS

Versioned domain records are written with a `PluginDataStore` primitive that the host owns. CAS (compare-and-set) means "check the versions first, and write only if all of them match". Both the root `DataStore` and the transaction view have this method:

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

- `expectedVersion: null` requires that the record does not exist. A positive integer must match the `value.version` of the existing JSON record exactly.
- No row is changed until every check has passed.
- On a conflict it returns `false` and writes nothing.
- It throws on an invalid entry, a duplicate `(namespace, key)`, or an infrastructure failure.
- The outer transaction still handles the rollback of all other writes.
- It is not a new table, not a general JSON merge API, and not permission to write another plugin's partition.

Every backend requires the parent session to exist, even for an empty batch used as a write barrier. If the session does not exist or has been deleted, it throws `SessionNotFoundError` (`code: session_not_found`), and no ownerless row is left behind.

How each backend does it:

- **Memory**: checks and replaces the whole batch inside the store boundary where it serializes access.
- **SQLite**: uses `BEGIN IMMEDIATE` when it owns the transaction. When the caller has already opened a transaction, it reuses that one and does not nest.
- **PostgreSQL**: inside the transaction, it first locks the parent session row with `FOR UPDATE`, then checks and writes. The lock is held until the caller has finished writing the ledger and the receipts. "Read first, then a normal upsert", or relying only on an in-process session lock, does not count as CAS.
- **BrowserVault**: keeps its existing atomic checkpoint / revision convention. It is not an IndexedDB implementation of `DataStore`. The checkpoint keeps the dimension records that were adopted, their versions, source references, and settlement receipts.

Dimension initialization, updates, and imports all use this primitive.

- The shared schema and value validators run once more at the commit boundary.
- The generic `plugin.data`, batch, and delete paths may not write `_dimensions` or `_dimension-settlements`.
- Settlement succeeds only if every version that was read still matches. Dimensions that were evaluated but whose value did not change are included too.

### Dimension settlement and execution atomicity

**Registering the obligation.** The host registers a settlement obligation in the same transaction that commits the narrative. It uses the authoritative result ID and the logical turn number.

- The frozen definition and the versions read at that time are stored in the receipt.
- The narrative text is read from the source turn's artifact. It is not copied into each receipt.
- The updated values and the success receipt are committed in the same CAS batch (the same transaction).
- An explicit `no-change` also validates the read set and writes one receipt. It cannot be inferred from "no tool was called" or "the runtime succeeded".

**Initialization has only one write path**: its own `dimension.initialize` proposal.

- Like any other proposal, it goes through `PreStateCommit`, and it is committed in the savepoint of the runtime that proposed it.
- So: if it is rejected, nothing is written. If it is rewritten, the rewritten definition is written. If the runtime is discarded, its initialization is discarded with it.
- Before any runtime commits, `finalizeExecution` only binds the session to its dimension provider.

**Receipts freeze the committed records.**

- A receipt is registered where the provider runtime first needs it (before its first settlement update), and it is registered again after the last runtime.
- A receipt registered inside a savepoint that was rolled back is registered again, based on what was actually committed.
- If no committed dimension has rules, no receipt is registered.

**When a plan is rejected.** A rejected tracking plan may keep the story, and it leaves an explicit `pending-settlement` domain result. It writes no values and no success receipt.

- This does **not** change how `finalizeExecution` treats a `committed:false` proposal. If the execution has a committed story, the runtime that proposed it is discarded. Otherwise the whole execution is rolled back.
- An ordinary manual version conflict is still a rejected write. An infrastructure error is still thrown and rolled back.
- Notifications are published only after the durable commit.
- The next narrative is blocked until the pending source is retried, explicitly marked `manual`, or explicitly marked `skipped`. Changing a single value does not resolve it.

**Snapshots and recovery.** Receipts and the adopted definitions and values follow the existing snapshot, fork, and browser checkpoint paths. A source that has already finished is not settled again after a recovery or retry. For the five states, see [World Model](./world-model.md#turn-timing-and-settlement-receipts). For the boundary of the editor and tracker RPCs, see [API](./api.md#dimension-editing-and-recovery-of-pending-settlements).

> [!NOTE]
> Old raw-dimension worlds, and development sessions and checkpoints, must be rebuilt. There is no reading of the old format, and no double-write from dimensions to the lorebook.

## Backend implementations

First, two rules before commit that apply to every backend.

**Rejection or cancellation.** If the prepared commit plan records that the execution was rejected or cancelled, the final commit is refused before it enters the domain transaction.

- The caller's `extraInTx` writes, the buffered proposals, journal entries, suspensions, exports, snapshots, and the success completion event do not happen.
- Execution history that was already recorded is settled as failed.
- Client input that has already been stored is outside this boundary.

**The story must complete.** Completing the story is a condition for the commit. In each of the three cases below, the commit of the whole execution is refused before any buffered proposal, journal message, or player-turn count is committed:

- A runtime with `outputKind: story` failed.
- A story result succeeded, but the cleaned `narrativeOutput` is empty.
- A dimension provider failed in the same execution, so the executor held back the story (`dimension-snapshot-unavailable`).

Related rules:

- When the story is skipped for another reason (its guard, or a declared gate), the execution is not refused.
- Client messages that have already been stored are not part of this transaction.
- The story runtime is never given `runtime-done`. If the model calls it out of habit, the framework first asks it for the narrative with the few steps left. If the result is still empty, the runtime counts as failed.
- This does not retry or undo side effects that external tools have already caused.
- Optional system extractors can still fail after a valid story. Their failure does not discard the story.

### MemoryStore

Implemented with a two-phase snapshot. The snapshot is a **shallow reference copy** of each collection (`new Map(value)` / `[...value]`), not a deep copy.

- A transaction takes the snapshot lazily, when it first writes a collection. Which collection a method touches is decided by the mapping in `WRITE_METHOD_TOUCHES`. An unknown write method conservatively snapshots every collection.
- On rollback, the snapshotted collections are restored in place, so references the caller already holds stay valid.
- On commit, the shadow copies are simply dropped.
- File: `packages/store/src/memory/transaction-methods.ts`

> [!IMPORTANT]
> Correctness depends on records being treated as **immutable**: a change must replace the record with a new object, not edit it in place. That is why an O(rows) reference copy is safe. Under the "no in-place edits" rule, a deep copy is not needed, and it would cost much more.

### SqliteStore

Runs SQL directly: `sqlite.exec('BEGIN')` / `'COMMIT'` / `'ROLLBACK'`.

- The store is one synchronous `node:sqlite` connection. So `withTransaction` uses a promise chain to **serialize** concurrent calls: each call runs its full BEGIN…COMMIT, and the next one starts only after it. No one's writes are lost.
- File: `packages/store/src/sqlite/sqlite-transactions.ts`

### PgStore

`postgres.js` is a connection pool. A bare `unsafe('BEGIN')` is not bound to one specific connection.

- `withTransaction` uses Drizzle's native `db.transaction(async (tx) => …)`. It keeps a dedicated pool connection for the callback and issues BEGIN / COMMIT / ROLLBACK correctly.
- The store view inside the transaction scope sends each write to that connection. So concurrent `withTransaction` calls run on separate connections and are truly parallel transactions.
- File: `packages/store/src/postgres/pg-store.ts`

### Cross-backend semantics (read before adopting)

The three backends follow the same observable rules (atomic commit and rollback, nesting rejected), but they handle concurrency and isolation differently:

| Backend                       | Concurrency model                                                                                                                                          | Concurrent operations on the root store while a callback runs                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PgStore**                   | Each call runs on **its own pool connection** (Drizzle `db.transaction`), so transactions truly run in parallel.                                           | Reads see each one's own database snapshot. Writes stay on their own connection and are not merged into this transaction.                                 |
| **SqliteStore / MemoryStore** | **One connection / one live state.** The transaction and every read and write on the root store share one promise queue (a **serialized operation gate**). | **Queued until the transaction ends**: no dirty reads, and writes are not merged into the transaction. Operations issued through `tx` still run in place. |

#### The serialized operation gate (SQLite / Memory)

With only one connection or one live state, a transaction cannot isolate itself. Without this gate, writes issued elsewhere while the transaction is open would land inside it, and outside reads could see data that is later rolled back.

Session locks order only the turn writes of the same session. They are per session, and some routes do not hold a session lock at all (world import, character editing, settings). So a write from another session could vanish.

`packages/store/src/serialized-write-gate.ts` puts the transaction and all root-store operations into **one queue**:

- Reads and writes outside a transaction wait until the transaction ends.
- Operations issued through the `tx` scope run in place. They belong to this transaction, and queuing them would deadlock.
- Whether a call is "inside or outside" is decided by `AsyncLocalStorage`. So a truly concurrent caller that starts while a transaction is paused at an `await` is not mistaken for a nested call.

**The gate is set per connection, not per store.** All code that makes changes through the same `node:sqlite` handle shares one gate, obtained with `getConnectionWriteGate(db)` in `sqlite/shared-connection.ts`. The users are:

- the `DataStore` methods;
- the optional sqlite-vec capability (`VECTOR_WRITE_METHODS`);
- the mirrored MediaStore that intentionally reuses the same connection (`MEDIA_WRITE_METHODS`).

If vector or media writes did not go through this gate, such writes from another session could be merged into an open transaction and disappear with its rollback.

**Only storage work goes inside a transaction body.** The statements are already serial (`node:sqlite` is synchronous), but the gate is held for the whole callback, including any `await` in it. For this reason, the final execution commit runs the plugins' `PreStateCommit` hooks first, and only then opens the transaction.

**One connection per transaction (as PgStore does) is still the long-term answer for real concurrency.** This gate closes the correctness gap without rebuilding the storage connection structure. Regression test: `packages/store/tests/serialized-write-gate.test.ts`.

### Vector index initialization and transfer

**Initialization.** A registered vector model guarantees that its physical table exists.

- PostgreSQL initializes the registry row, the optional vector extension, the table, and the indexes in one transaction. It publishes the in-process cache only after the commit. A single advisory transaction lock queues the initialization across several processes.
- SQLite uses an immediate transaction and reads the model state directly. So an outer rollback does not leave a stale cache.
- A development registry that is already corrupted must be rebuilt.

**Not transferred with a session.** Snapshot, fork, and browser checkpoint transfers do not include the reserved `__kernel:vector` partition.

- Its ingest cursor and hashes describe a physical index on this machine. They are not session data that can be moved.
- Both the exporter and the importer enforce this rule. A rebuilt session re-indexes its own messages and lore.
- An ordinary plugin-data namespace with the same name is kept as usual.

**When ingestion runs.**

- The shared server-side commit entry point schedules best-effort ingestion only after `commitExecution` reports that the commit is durable. Player turns, manual runs, resumed runs, and background (detached) runs all use this entry point.
- Ingestion is also scheduled after a fork or a browser checkpoint replacement.
- At bootstrap, the configured embedding model lock is first established under the ingestion lease, and then the corpus is read.
- A scheduled run keeps going in bounded provider batches until the current corpus is fully indexed. A returned count that falls short, or a failed embedding, leaves the unfinished progress for the next run.

**Locks.**

- Ingestion uses its own per-session lock (an advisory lock when there are several PostgreSQL hosts). It never uses the turn lock.
- Lifecycle replacements and deletions take locks in this order: session → world if needed → ingestion → storage transaction.
- They wait for all deferred vector, cursor, hash, and archive deletions to finish before they replace or delete the state. The same applies to a checkpoint that keeps `createdAt`.
- A memory index rebuild ([`POST /api/sessions/:id/memory-index/rebuild`](./api.md#post-apisessionsidmemory-indexrebuild)) also changes the model under the ingestion lock: it waits for the ingestion in progress to finish, and schedules a new one once the model is changed.
- While an embedding run is in progress, normal turns can still commit. The ingester merges the commits into the next pass so that it reads them.
- On shutdown, tracked memory tasks are drained before the storage is closed.
- An embedding failure does not change the result of a committed turn.

**A fork keeps the character IDs.** Every backend uses `(sessionId, id)` as the key for characters. So the plugin references that are copied over and the snapshots of the child session point to the same characters in the child session's store.

### MediaStore transaction and concurrency fixes

Media lifecycle changes sit outside the DataStore transaction and have their own per-resource atomicity:

- **SQLite / local-fs**: during cleanup, the final owner / reference check and the resource deletion are done inside `BEGIN IMMEDIATE`. Its MediaStore shares the DataStore connection gate, so concurrent transactions do not absorb or lose a media write when they roll back. Cleanup reports only the resources that were actually deleted.
- **PostgreSQL**: the `put`, ownership, reference, delete, and cleanup operations use transaction-level advisory locks keyed by content ID. This queues "first writer wins" and the races between reference and delete across several processes. Cleanup also uses `NOT EXISTS` in its guarded delete statement.
- **IndexedDB MediaStore**: keeps the ownership and reference updates atomic inside its object-store transaction. It is only a media backend. Persisting game state in the browser is handled by [BrowserVault](#browservault-transactions) below, which is not an IndexedDB version of DataStore.

### Nesting is rejected on every backend

Calling `withTransaction` inside a `withTransaction` callback is a programming error. All three backends **reject it synchronously, with a clear error**:

- **Serialized backends (SQLite / Memory)**: the inner call would queue on the serial chain behind the outer transaction, while the outer one waits for the inner one. This is a permanent **deadlock**. The guard turns this silent hang into an immediate rejection.
- **PgStore**: nesting does not deadlock (the connections are independent), but the inner call would run as a **separate, non-atomic transaction**: a rollback of the outer one cannot undo the inner commit. It is rejected too, so the rule is the same everywhere and this silent surprise is avoided.

Error message: `"<Store>: nested withTransaction is not supported on the
<backend> backend; <reason>. Flatten the nested call, or perform the inner
writes directly through the outer callback's tx scope."`

#### How nesting is detected

SqliteStore, MemoryStore, and PgStore (all running on Node) use the same method:

- An `AsyncLocalStorage` scope (`packages/store/src/tx-nesting-guard.ts`) marks the async context of a running callback.
- When a new `withTransaction` starts, it checks `isNested()` synchronously. Only a re-entrant (nested) call returns `true`. Independent concurrent callers return `false`, so legitimate concurrency is not reported as an error.
- The shared error constructor is in `packages/store/src/tx-nesting-error.ts`.
- This guard exists only on Node, because all `DataStore` backends run on the server.

## BrowserVault transactions

Browser-private persistence is kept deliberately outside `DataStore`. Dexie manages the IndexedDB transactions and the schema lifecycle. The code is in `apps/web/src/services/storage/browser-vault.ts`.

**Writes.**

- A checkpoint and its compact "action idempotency" record are committed in the same `rw` transaction.
- Only the latest full checkpoint is kept.
- `baseRevision`, `revision`, and `actionId` are used to reject stale or out-of-order writes.
- World edits and local checkpoint writes use the current browser world record. So an older session checkpoint cannot undo an edit that was already saved.

**Deletes.** When a browser world is deleted, its linked checkpoints, commit metadata, and pending commits are removed atomically. The session mirrors it owns are cleaned up on a best-effort basis. Shared worlds on the server are not deleted.

**Uploads and downloads.**

- Uploads and downloads of browser checkpoints are serialized by `LocalDataService`. Before hydration or staging another action, it restores the persisted pending commits.
- When the temporary session does not exist, it clears the pending mark and allows a rebuild from the browser checkpoint. Other errors keep the mark and block newer commits.
- Checkpoint export reads `listTurnResults(sessionId)` and `listRuntimeOutputs(sessionId)`, and keeps only the rows of the latest 40 executions (`JOURNAL_EXECUTION_WINDOW`). Executions that were interrupted and have no turn-result row are not saved in the checkpoint.
- Before it uses a revision or an idempotency cache, the upload and commit routes check the owner, the incarnation, and the deletion state again inside the session lock. A cache entry belongs to one incarnation. After the same ID is created again, the old entries are discarded.

**Import and replacement.**

- When a session is replaced from a checkpoint, the temporary server workspace uses `MemoryStore.withTransaction`.
- Before a write transaction starts, checkpoint import checks the structure and session scope of each record, including the content of snapshots.
- A trusted fork copy uses `rebindSnapshotPayloadSession` to bind nested state to the child session. Export normalizes old fork content before it runs the transfer checks. External checkpoint input is never rebound, so it cannot get around the ownership check.
- `replaceSessionFromCheckpoint` keeps the global world by default. The caller must first authorize global writes on its own, and then explicitly choose `writeWorld`. Owning the session alone does not authorize updating a shared world.

This is a synchronous convention. It does not try to recreate the full server transaction API in the browser.

## Kernel integration

There are two layers of transaction boundary:

- **`commitAll`** (`packages/runtime/src/commit/session-commit-pipeline.ts`) commits the chain of proposals from **one runtime** into one `withTransaction` callback. It is the lowest-level commit primitive.
- **`finalizeExecution`** (`packages/runtime/src/commit/finalize-execution.ts`) wraps all runtimes of **a whole execution** in **one** `withTransaction`. "The whole execution" means the top-level results, plus the flattened results of nested `recursiveCall`.

Who calls it:

- The three commit owners (`actions.ts`, `plugin-rpc/runtime-turn.ts`, `resume.ts`) pass the whole `{ result, commit }` returned by the public execution entry point to `commitExecution({ execution, ... })`.
- The commit plan records the schema, hook settings, journal, suspensions, and nested results at execution time. The host no longer reloads the schema or assembles these fields by hand.
- If a declared export has no schema, the whole transaction fails.
- `commitExecution` enters this boundary, and then the same host entry point coordinates notifications, snapshots, and memory scheduling.

**`loreOverride` is not in the turn transaction.** When `start_session` has `loreOverride`, the server writes it into the session metadata first, and only then enters the turn transaction. So a later turn failure does not undo this write. This is intentional: later turns and other instances see the same snapshot of the world background.

**Wrap-up of `/api/actions`.** `onFinalized` settles the host marker only from the durable outcome, and puts it in the observation queue. It does not wait for the SSE to be consumed. The automatic snapshot still runs under the same session lock.

- A write error, a queue overflow, an observation deadline, and a drain failure outside the lock must not change a committed artifact to failed. They must not open a replay of the same turn for recovery, and they must not retry the model.
- Recovery relies on the persisted artifact and the read-only execution and session endpoints. It does not depend on whether the last frame was received.

### Turn-level single transaction

`finalizeExecution` gathers all runtimes of a turn (including nested `recursiveCall` results) into one transaction. Here is how it behaves, point by point.

**Failure boundary that favors the narrative.**

- A store error thrown by a domain write rolls back the whole turn.
- A `{ committed: false }` returned by handler validation (for example a PreStateCommit veto, or a `state.patch` missing a field) rolls back only the optional runtime that proposed it, when this execution has a successful story result.
- How: each non-story, non-setup runtime commits in its own savepoint. When it is rejected, only its own writes are undone. The narrative and the other runtimes are committed as usual.
- In this case `FinalizeExecutionOutcome` returns `committed`, and lists the dropped parts in `failedProposals` / `isolatedRuntimes` (`{ runtimeId, error }`). The main turn tells the client with `proposal.failed` and the runtime's `runtime.failed` SSE event.
- Executions without a story (manual, background, detached, setup) are still atomic as a whole: if any one proposal fails, the whole thing is rolled back. A job does not report success for writes that were not stored.
- An effect entry in the result that cannot become a proposal also counts as a write rejected for that runtime, and is handled by the boundary above. It does not bring down the whole turn with an exception. These entries are: entries in `effects.ui[].parts`, `effects.interactions`, `effects.notifications`, and `effects.statePatches` that are not objects, and content of the last three channels that is not an array. A function runtime fails with `output-schema-invalid` when its handler returns them.

**Export publishing has its own failure boundary.**

- For each `recordAs` export, reading, sequence allocation, and appending happen in one savepoint.
- When one export's storage fails, the savepoint is rolled back first, then the diagnostic is recorded, and then the other exports and the domain commit continue. This way PostgreSQL does not leave a caught SQL error in an aborted transaction.
- A missing declared schema, and a failed public output contract check, are still handled at the normal execution validation boundary.

**Downstream commits only if upstream really commits.** Results are committed in execution order. The hard dependents of a dropped runtime are dropped with it (`commit/commit-dependencies.ts`).

| Relationship                                                                             | When the upstream is dropped                              |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| The target of a turn-scoped `needs`                                                      | Downstream is dropped with it                             |
| The source of a required `inputs`                                                        | Downstream is dropped with it                             |
| An event subscriber, when all emitters of the event that triggered it are dropped        | The subscriber is dropped with it                         |
| `after`, and inputs with `required: false`                                               | No cascade. They only express order or a best-effort read |
| A `cardinality: one` capability dependency, when another provider committed successfully | Still satisfied                                           |
| The hard upstream of a story or setup runtime                                            | The whole turn is rolled back                             |

The second argument of `extraInTx` gives the dropped runtimes. The main turn uses it so it does not queue detached jobs and background event followers that depend on them. A detached job that is still queued records the dropped runtimes as `failed` in the frozen turn digest and in the upstream results.

**PreStateCommit runs outside the transaction.**

- Finalize completes normalization, guards, and the PreStateCommit hooks first, and only then opens the transaction. Inside the transaction, only writes happen. `createCommitPipeline().commitAll` works the same way.
- Hooks do not read storage state, so running them earlier does not change the meaning. The benefit is that waiting on a plugin hook no longer holds the SQLite / Memory serial gate.

**Player stop and commit share one boundary.**

- `finalizeExecution` accepts an optional `signal`. It checks for cancellation when the transaction starts, while it processes the results, and before it returns. It passes the signal to the `PreStateCommit` hook of each proposal.
- A cancel ends the hook wait at once, stops the remaining proposals, and rolls back the whole thing.
- The main turn passes the player's control signal. Even if the story has already been generated, if the cancel happens during post-processing or a commit hook, the transaction is still rolled back as a whole.
- Notifications and `PostStateCommit` hooks that run after the database has committed do not inherit this cancel signal. They finish their wrap-up with their own timeouts.

**The conversation log and the commit succeed or fail together.**

- The current player input, and the `TurnMessage` of non-manual runtimes, are held only in an in-memory journal during execution. After all proposals pass, `finalizeExecution` appends them in the same transaction.
- A rolled-back execution does not enter later prompts, trigger statistics, or compaction.
- `actions.ts` also commits the REST messages mirror and the player InteractionRecord through `extraInTx`. So a page refresh and the observation surfaces do not keep a rolled-back input either.
- The manual and background paths keep to their own rule of "not appending to conversation history".

**Settling `commit_status`.**

- On success, `turn_results.commit_status` is settled to `committed` in the same transaction. On rollback, it is settled to `failed` outside the transaction, and idempotently.
- Nested recursiveCall results reuse the top-level `turnId`. So one settlement of the top-level `[turnId]` covers all the nested rows.
- The `committed` settlement also changes the records of dropped runtimes in `runtimeResults` to `failed`, and writes the reason. History, retries, and refreshes all see the results that were actually stored. Any job they reported is also closed as `failed`.
- As with other failed runtimes, a dropped runtime writes nothing to the conversation log (text, interactions, and UI cards), and it is not counted in the trigger ledger (`maxTriggerCount` / `cooldownTurns`).

**The completion barrier is still held.** If anything fails, `turn.completed`, the post-turn memory ingestion, and the auto-snapshot do not fire. Each failed proposal emits one `proposal.failed` event. To the client, the turn shows as visibly unfinished, not as "succeeded but with missing state".

**Externally visible notifications are sent after COMMIT.** Externally visible fan-out (emitter events plus PostStateCommit hooks) is buffered while the transaction is open, and is sent in order only after COMMIT. On rollback, the buffer is discarded too. A client never sees a "committed" event for writes that were rolled back.

**Resume.**

- Resume puts the assistant's turn message and the suspension's resolved mark into the same transaction through `extraInTx`. If anything fails, they are rolled back together with the proposals. After the claim is released, it can be retried.
- The resolved mark also clears what this resume has already used from the suspension (messages, buffered tool calls and proposals, input), and keeps only the execution identifier, the player turns and plugin version recorded at suspension, the language, and the turn number. On rollback, this content is restored with the transaction.
- Abandoning, expiring and voiding go through one exit: deleting the suspension, counting the turn (when it was the last suspension of its logical turn still waiting) and queuing the detached jobs the turn held back happen in one transaction.

**The session clock is written in the same transaction.**

- The player path (`actions.ts`) uses the `sessionClock` argument to put two things into one transaction, placed "after the proposals are committed and before `commit_status` is settled" (`applySessionClockTx` in `commit/session-clock.ts`):
  - The logical turn count: `completedPlayerTurns` advances idempotently through the logical-turn ledger.
  - The setup-phase flip: `phase: setup → playing`, and the `setupRuntimes` mirror.
- The API and snapshots store the current-only clock fields directly.
- When a whole turn is rolled back (a story or setup failure, or any proposal failing in an execution with no story), the count, the phase, and the setup mirror do not advance, and the ledger is not written.
- A commit that only drops optional runtimes advances the clock as usual.
- Manual and background finalization do not pass `sessionClock`, so the clock does not move.
- Resume does pass it. The count is advanced once, when the last suspension of the same logical turn is resumed, abandoned, expires or is voided. When the resumed runtime is a setup runtime and it reports completion, the `done` mirror and the phase flip (when all setup runtimes are complete) are written with this commit. The attempt ledger keeps the attempt that was in place at suspension.

**Lock boundary of action-level plugin-rpc.** An action handler does its reads, validation, and writes inside the session lock. So it does not interleave with a turn of the same session. PG multi-process deployments are also serialized by the same distributed lock key.

**Interaction answers and follow-up turns.**

- The `submit_interaction` action validates the answer inside the turn's session lock, and confirms that it has not been answered before. Then one store transaction writes the batched player input and the `turn.started` of the follow-up turn.
- So saving the answer and starting the turn succeed or fail together. A duplicate submission sees the existing answer inside the lock and is rejected. A state where "the answer is saved but the turn did not start" cannot happen.
- The turn's own result is still committed by `finalizeExecution`. If it fails, the answer is kept, and the turn runs again through the existing retry.

**A transaction is required.** `finalizeExecution` requires a full DataStore and calls `withTransaction` directly. There is no fallback that commits a turn without a transaction. When the lower-level `commitAll` receives a `StoreTransaction` view, it no longer opens a nested transaction. Instead, it reuses the caller's transaction. This branch does not mean that a full DataStore may omit its transaction implementation.

**Fork is a different case.** Fork (`snapshots.ts`) is a separate session-rebuilding transaction. It replays a snapshot and **commits no proposals**, so it does not go through `finalizeExecution`. Both use the pattern of "one `withTransaction` wrapping the whole write sequence", but they have different concerns.

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

When a session is created with `worldData`, the same `DataStore` transaction convention is used. The server first builds and validates the import plan, and then wraps the session row and the writes managed by the importer in one transaction:

- `sessions`
- `plugin_data`
- `lorebook`
- `characters`
- the media index rows stored in `plugin_data`
- `world_data_import_ledger`

Before the import starts planning any writes, it parses the locale override file. A source's `localeArrayKeys` gives the identity fields of nested lists (placed after `key` and `id`). So when the author reorders a list, the translation records still match. Sync works the same way.

### Import ledger

`world_data_import_ledger` records the source of each session-data row that the importer manages: target, plugin ID, namespace, key, source digest, value hash, schema ref, source ID, and the managed flag.

`/api/worlds/:id/sync-data` uses this ledger for three things: dry-run, hash-based conflict detection, and an explicit `force` sync.

Dimension declarations also go into the ledger, including inline declarations, external declarations, and saved worlds.

| Situation                                                                                                | Result                                                                               |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| The declaration has not changed                                                                          | Progress is kept                                                                     |
| A new declaration is added                                                                               | Its value is initialized                                                             |
| A record that has already evolved, was edited by hand, or has a pending settlement is changed or deleted | A conflict is produced                                                               |
| `force` is used on the conflicts above                                                                   | Does not get around these protections, and does not migrate values to the new schema |

- Apply checks the ledger hash and the record version again inside its own transaction. On a conflict, it keeps the existing definition, value, and version.
- Rows with conflicts are reported and left as they are. They do not block the other rows in this sync.

### Media

The bytes of media are stored in `MediaStore`. Its lifecycle is separate from `DataStore`.

- World data import validates media in its preflight stage.
- When a media object is written, a single temporary reference is set up atomically at the same time, and only then is the media index row written in the session store. On failure, the `DataStore` transaction is rolled back.
- The temporary reference protects bytes that are not yet published from being reclaimed by a concurrent GC.
- Finalization first sets up the session's ownership claims, and then releases the temporary reference. When preparation or publishing fails, only the temporary references of this one attempt are released.
- When sync deletes an import-managed media index row, it removes only that one explicit media reference of the current session. The lifecycle GC reclaims the bytes only after all ownership and reference claims are gone.
- A failure to release a temporary reference is logged, and it does not hide the result of the import itself.
- A process crash may leave a fixed reference (pin) behind. It expires 24 hours after it was created, and `POST /api/media/cleanup` releases it (see [Media store](./media-store.md#temporary-references-during-world-data-import)).
- When the semantic data is already committed but media finalization fails, the temporary references are kept to protect that data. Creation rollback releases them only after the session deletion succeeds.

### Observability

The `trace_events` produced by a transactional commit are the same as for a non-transactional commit (proposal apply, commit success or failure). The trace has no dedicated "transaction mode" field for now. To check whether a run used a transaction, look at the storage backend in use.

## Schema changes

The table and index DDL is generated from the Drizzle schema (`packages/store/src/{sqlite,postgres}/schema.ts`) by `packages/store/src/common/ddl-codegen.ts`, using `CREATE TABLE IF NOT EXISTS`.

- In the early development stage, the store does not migrate old data. A database created by an earlier build can start only if its tables already match the current ones.
- A change to a table, constraint, or index that old rows do not satisfy is listed under Breaking in `docs/CHANGELOG.md`, with a note on which development data must be rebuilt.
- At startup, the store deletes retired tables and retired plugin-data namespaces. This is deletion, not conversion.

## References

- The contract type: `packages/store/src/types.ts` (the `DataStore` interface)
- Contract tests: `packages/store/src/contract/store-contract.ts` and `packages/store/src/contract/suites/`
- `withTransaction` nesting guard: `packages/store/src/tx-nesting-guard.ts` (Node only, AsyncLocalStorage) and `packages/store/src/tx-nesting-error.ts` (the error constructor, which is also safe in the browser)
- Kernel commit path: `packages/runtime/src/commit/session-commit-pipeline.ts`, `packages/runtime/src/commit/session-commit-handlers.ts`
- MediaStore schema: [`media-store.md`](./media-store.md)

## Consistency boundary for world data writes

- **`POST /worlds/:id/sync-dimensions`** syncs only the dimension ledger and the protected `_dimensions` records. It re-validates and applies inside **SessionLock + store transaction**, and it does not rebuild `entries` or the Lorebook. Dimensions that have evolved, were edited by hand, or have a pending settlement stay as they are, and are listed in the conflict report. The other dimensions are written as usual. On a storage exception, the whole thing is rolled back and it returns 500.
- **The conflict scan of `POST /worlds/:id/sync-data`** runs outside the transaction, because it reads the world package from the file system. So the apply transaction **re-reads the hash and does a CAS** for each target it would overwrite. If something changed after the scan, the whole thing is aborted and it returns `409 { code: "world_data_sync_conflict" }`. The caller runs it again, and the new scan reports the change as a normal conflict. Ordinary domains can explicitly use `force`. The dimension "evolved / pending settlement" protection is not lifted by this. Dimensions use batch CAS and hold the session write barrier. The route also holds SessionLock, which blocks concurrent turn writes.
- **Media and the DataStore have different lifecycles.**
  - Session create and sync prepare media before the semantic transaction. `put` atomically sets up a temporary reference that belongs to this import.
  - On a successful publish: first set up the session claims, then release the temporary reference.
  - A failure before commit: only this attempt's temporary reference is released. Bytes with no owner are left to the GC, and content is not forcibly deleted.
  - A failure in finalization after commit: the protection is kept. It can be released only after a creation rollback has successfully deleted the session.
  - A compatible entry point that materializes inside a DataStore transaction follows the same reference rules.
  - A process crash may leave temporary references behind. They expire 24 hours after they were created, and the media cleanup endpoint releases them.
- **The compactor's** summary write and message tags are in the same transaction. Writing only the summary creates an orphan: `message-insertion` emits it as a system message, while the untagged raw history is still injected, which makes two copies of the context.

### Memory extraction jobs

Memory extraction uses the generic detached runtime job.

- The story's commit transaction saves `turn-digest@1` and the job record at the same time. Credentials are kept only in an in-process handoff table. If the transaction fails after registration, the matching credentials must be cleaned up.
- The worker commits the plugin block's proposals and the job's completion receipt in the same transaction.

`completion.settle: before-next-execution` makes the next execution wait for these jobs at its entry point.

- While waiting, it does not hold the SessionLock. It checks again after it gets the lock.
- When the declared wait budget is exceeded, it records a trace and continues.
- A cancel request only aborts the wait.
- Jobs for the same session / runtime are handled in the order of their source turns. A failure or a timeout lets the job through as a final state.
- An explicit retry does not overwrite a job for a newer source turn.
- After a process crash, an extraction that was already claimed is not replayed automatically. This avoids duplicate calls and old content overwriting new content.

Credentials and shutdown:

- Services brought by the original request are preferred, then the server configuration that is available. For deployments where credentials come only in request headers, the service is supplied later by a subsequent authorized request.
- The queue and snapshots do not store API keys.
- The credential table is in-process state. It does not guarantee "the original request wins" across instances.
- When the service shuts down, it stops claiming, cancels tasks that have not yet entered commit, and waits for the storage operations held by workers to be released. A transaction that has already entered commit is allowed to finish.
- This does not guarantee that all memory extractions drain successfully. Vector ingestion is still a separate path.

## Derived vector-index progress

**How ingestion handles failures.**

- Embedding ingestion uses bounded batches, and it limits the length of each input text.
- A rejection that clearly targets one piece of content is split in half, again and again, until the bad item is found. That one item advances the cursor without a vector, so the items after it can continue.
- Authentication failures, unknown errors, and temporary errors do not skip an item for good.
- When archived content is replaced, the old vectors are removed even if the new content cannot be embedded.

**Atomic batch writes.** `VectorStoreCapability` provides `getVectorIndexProgress(scope)` and `commitVectorIndexBatch(input)`, which write vectors and index progress atomically.

- The scope is `(sessionId, pluginId, namespace)`.
- An update requires two things: the serialized value read earlier (`null` means it does not exist), and `expectedSessionCreatedAt`.
- A batch can contain `deletes` (namespace / key pairs) and `upserts` (namespace / key / embedding / payload), limited to the same session and plugin.
- The progress namespace identifies the cursor or the hash table. Each vector change names its own data namespace.
- Deletes run first, then upserts. All changes are committed together with the new progress value.
- A CAS conflict returns `false`, and the vectors and the progress both stay unchanged.
- If the session incarnation has expired or does not exist, or if any single change is invalid, it throws and rolls back the whole batch.
- The optional `expectedModelRegistryId` names the model the batch was embedded with. When the session is locked to another model, it throws and rolls back the whole batch.

Per backend: PostgreSQL holds the parent session row with `FOR KEY SHARE`. SQLite uses an immediate transaction. Memory uses the store boundary where it serializes access. These operations do not run on the business-data view of `StoreTransaction`.

**Changing the model.** `VectorModelOps.resetSessionVectorIndex({ sessionId, expectedSessionCreatedAt, expectedModelRegistryId, target })` deletes, in one transaction, every vector and all progress the session has under its current model, then locks the session to `target` (`null` leaves it unlocked). When the session is not locked to `expectedModelRegistryId`, it returns `false` and changes nothing; a wrong incarnation throws. PostgreSQL locks the session row with `FOR UPDATE`, which waits for vector writes holding `FOR KEY SHARE`.

**Where the progress is kept.** Progress belongs to `vector_index_progress`, not to `plugin_data`.

- Cascading deletion of a session clears it in the same transaction. Rolling back that cascade restores it.
- Snapshot and checkpoint exports structurally do not include it. So a restored or forked session rebuilds its index from its own source data rows.

**Deletion and concurrency.**

- `deleteVectors` optionally accepts a `key`, which removes one item in the selected scope. It also optionally accepts `expectedSessionCreatedAt`, which rejects an out-of-date asynchronous deletion.
- Ingestion first reads all archive sources and finishes the embeddings. Then it commits the matching deletes, upserts, and progress as one batch.
- An older scan cannot overwrite vectors that are owned by a newer progress value.
- An optional cross-process ingestion lock can reduce duplicate embedding work, but correctness does not depend on it.
- Calls to the embedding provider never run inside the index commit transaction, and never inside the business-data transaction.
