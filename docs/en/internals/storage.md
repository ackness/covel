# Storage

This page explains where Covel keeps its data, who is responsible for it, and what each place guarantees. It is for developers who change the storage layer, track down data problems, or deploy the service. Players who only want to know which folder holds their saves should see [Data and upgrades](../start/data-and-upgrade.md).

Covel does not use one large storage adapter to cover every environment. It has three configurations (profiles), split by how the app is deployed. There is one record format, and each environment uses the database that suits it.

| Profile           | What is the final source of the data                   | Storage used to run turns               | Where it is deployed                               |
| ----------------- | ------------------------------------------------------ | --------------------------------------- | -------------------------------------------------- |
| `browser-private` | Dexie `BrowserVault` in the player's browser IndexedDB | A temporary `MemoryStore` on the server | Public demo pages, self-hosted browser-only setups |
| `desktop`         | Server-side `SqliteStore`                              | The same SQLite                         | Electron desktop app, single-user local installs   |
| `cloud`           | Server-side `PgStore`                                  | The same PostgreSQL                     | Hosted deployments, multi-process deployments      |

The contracts and implementations for each kind of data:

| Category                                     | Contract                              | Implementation                                                               |
| -------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| Server-side business records                 | `DataStore`                           | Memory, SQLite, PostgreSQL                                                   |
| Business records kept private in the browser | `BrowserCheckpoint` / `SessionCommit` | Dexie `BrowserVault`                                                         |
| Binary assets                                | `MediaStore`                          | Memory, SQLite, PostgreSQL, or a browser IDB cache that is chosen explicitly |
| Frontend UI data and caches                  | App KV and media cache                | Lightweight native IndexedDB                                                 |
| Preferences and credentials                  | Settings / configuration contracts    | localStorage, Electron IPC, desktop and server config files                  |

The browser no longer re-implements the server's create, read, update, delete and transaction methods, and there is no `IdbStore`. `@covel/store` owns the contracts for domain records and checkpoints, and `apps/web` decides how things are persisted in the browser.

## Server Backend Selection

`STORE_BACKEND` decides only the server's `DataStore`:

| Value    | Use                                                      | Notes                                                                                                           |
| -------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `memory` | Tests, and turn execution in browser-private mode        | In-process only. Lost on restart. The health check reports `frontendMode: "local"`.                             |
| `sqlite` | Desktop app, local development, single-node self-hosting | The file path comes from `SQLITE_PATH`, default `./data/covel.db`. The driver is Node's built-in `node:sqlite`. |
| `pg`     | Hosted deployments, multi-process deployments            | `DATABASE_URL` must be set. Session locks use PostgreSQL advisory locks.                                        |

There is no `STORE_BACKEND=idb`, and no `createStore({ backend: "idb" })`. If you write an unknown value (for example, `postgres` instead of `pg`), the service refuses to start, and the error lists the valid values. `MEDIA_BACKEND` and `VECTOR_BACKEND` work the same way.

**One SQLite file belongs to one service process.**

- `createStoreFromEnv()` takes an exclusive lock by creating `<SQLITE_PATH>.lock`, which records the holder's pid and start time. The lock is deleted when the store closes or the process exits.
- A second process that starts on the same file (for example, the desktop app and the dev server pointing at the same Covel home directory) fails to start. The error names the file and the holder's pid.
- If the pid in the lock is no longer running, the lock is stale and gets taken over.
- Opening the same file twice in one process is not a conflict.
- Code that opens the database file directly with `createStore()` (tests, tools, read-only scripts) takes no lock. The memory and `pg` backends take no lock either.

**Code layout of the SQL backends.** Each of the two backends has its own directory, `packages/store/src/sqlite/` and `packages/store/src/postgres/`, and they are split in the same way.

- `*-store.ts` (`sqlite-store.ts`, `pg-store.ts`) is a very thin factory that assembles the modules into a `DataStore`.
- `schema.ts` defines the tables, and `*-schema-ddl.ts` creates them.
- `*-store-mappers.ts` converts between database rows and records.
- Queries are grouped into one file per feature area: sessions, runtime records, snapshots, state, worlds, plugin data, export, lifecycle, and server settings.

When you add a table or a query, put it in the module for its feature area, add it to both backends, and do not put it in the factory.

**The media backend is chosen separately.** `MEDIA_BACKEND` does not depend on the data backend. `mirror` means it follows the current server data backend. An explicitly chosen browser IDB is only an implementation for media and caches. It is not a business `DataStore`.

**PostgreSQL does not mean automatic failover.** PostgreSQL lets multiple processes coordinate database writes, session locks and EventBus event dispatch. But the "steer" and "cancel" of a turn still depend on the in-process execution handle, so a request must reach the instance that is running that turn. The guarantees after a restart also differ for legacy background jobs and for persisted staged jobs. These limits are recorded in [API multi-instance boundaries](../reference/api.md#limits-of-running-several-instances).

**World settings are not cached per process.** The schemas of world settings and memory blocks are read every time from the DataStore being used. A committed change, or a replacement with the same ID, is visible on the next read. Separate store instances do not accidentally share world records. Runtime settings are taken once at the start of each operation, and later changes do not affect an operation already in progress.

**Deleting archived vectors.** Before archived vectors are deleted, both sources, the characters and the lorebook (the setting collection), must be read successfully.

- If reading either source fails, this round of archive cleanup is aborted. The existing vectors and content hashes are kept, and a warning with the session information is emitted.
- If reading a source succeeds but its content is empty, the empty result is trusted, and outdated entries are still deleted.
- The next normal cleanup can reuse unchanged hashes and does not need to call embedding again.

## Memory Index Ownership

`MemorySystem` manages its own background jobs. Before the host closes its store, it stops whatever produces the jobs, calls this instance's `drain()`, and then checks `pendingTaskCount()`. Separate instances do not share a process-level drain barrier.

**Checking sources at query time.** Before a query on archived vectors returns content, it checks the candidates against the current character and lorebook records. If a candidate has been deleted or changed, the query falls back to keyword search until the asynchronous write job refreshes the index. Writing the lorebook through the API also schedules a write job. Deleting one archive source removes only its own vectors. The other unchanged vectors are kept, and embedding is not called again.

**Where progress is stored.** The recall cursor and the archive hashes are stored in the `vector_index_progress` table. They sit next to the physical index, not in `plugin_data`.

- When progress is written, the previously serialized value is compared. The session's "incarnation" is also checked inside the backend's write boundary. (If the same ID is deleted and then recreated, it counts as a different incarnation.)
- Deleting or replacing a session clears both the progress and the vectors. A transaction rollback restores the progress.
- Business snapshots, forks and browser checkpoints do not copy it, so each of them rebuilds its own index.

> [!IMPORTANT]
> This changes the development-time storage contract. Development databases and browser checkpoints that contain the old layout, where the index was written into `plugin_data`, must be rebuilt. There is no compatibility for reading, migrating or filtering old data.

**Package exports.** The root entry of `@covel/store` exports only the contracts and the lazily loaded factories. To use a backend's constructor directly, import it from `/memory`, `/sqlite`, `/postgres` or `/indexeddb`. When you import only the contracts or the factories, the native database drivers are not all loaded.

## Server World and Session Deletion

Deleting a world is orchestrated by the world's DELETE endpoint, in these steps:

1. Under a short-lived `world:<id>` lock, record a persistent "deletion lease", then release the lock.
2. Delete the world's saves one by one, using exactly the same path as the session DELETE: wait for writers and background work to finish, run SessionEnd, release media references, and clear the session's temporary state.
3. Only after no sessions remain, delete the world record and the generated world package.

The underlying `DataStore.deleteWorld` deletes only the world record itself.

**Lock order.**

- Creating a session, a fork, or replacing a checkpoint: take the session lock first, then the world lock, and then commit.
- When deleting a world, the world lock is never held while waiting for a session or a runtime hook.
- A world marked as "being deleted" rejects world edits, new sessions, forks and checkpoint replacements. Seed imports and file reloads also respect this mark, and after they get the lock they read the disk contents again.
- Every server path uses the `SessionLock` chosen by the backend, including the PostgreSQL advisory lock.

**Failures and retries.** A cascading delete is not one large transaction covering all sessions.

- If cleanup fails, the world is kept, with a marker that allows a retry. Sending the DELETE again continues the remaining work.
- An expired lease can be taken over by someone else after ten minutes.
- A client cannot set or clear the reserved field `metadata.worldDeletion`.
- When creating a session or a fork with a world ID, that world must exist and must not be in the middle of being deleted. Sessions without a world are still valid.

The browser Web Locks coordination described below covers a different workspace, one that the client owns itself. In remote mode, the display cache in the browser is still managed by the frontend.

## Browser-Private Protocol

In browser-private mode, the player's data is authoritative in the browser. The server may read the API key from the request headers and run a turn, but it must not persist the player's checkpoints or credentials.

### Session Header

The BrowserVault schema 6 stores a small "session header" next to each checkpoint: the session record, the revision number and the commit time. Writing a checkpoint, applying a commit, and deleting a session all update it in the same IndexedDB transaction. The session list and the lock ownership check read only the session header, and they do not decode the whole conversation history. Earlier development-time vaults must be rebuilt. There is no migration, and they do not fall back to reading the old checkpoint rows.

### What a Checkpoint Contains

Every action uploads and downloads the whole checkpoint. So it holds only what does not grow with the number of turns, plus the conversation itself:

- All game state, messages and prompt history: kept in full.
- The turn results and runtime outputs of the last 40 executions. (A retry must name a recent turn as its source.)
- The latest revision of each runtime export. When a background job has not finished, it also carries the revision that was in effect at the start of the source execution of the earliest such job, along with every later revision, because the job reads the export as it was at that moment.
- The trace rows `turn.started` / `turn.completed` / `turn.failed`: the execution status is read from them.

Tool call logs, event records and the remaining trace rows are read only by the debug page, so they stay in the server workspace that produced them. For this reason, the debug page of a private session does not show model calls.

### Size Limit

The uploaded JSON is at most 64 MiB (`BROWSER_CHECKPOINT_MAX_BYTES` in `@covel/store/browser-sync`). The protocol has no "partial upload", so a session above the limit cannot continue. The web client measures the size of each upload, and when it reaches 80% of the limit it warns the player (once per session, per page load). This gives the player a chance to start a new session and carry the story on before an upload is refused with `413`.

### Generating a World

Before generating a world, the storage capability check must succeed first, and only then is the destination chosen. Browser-private mode uses `return-only`, which stores the result in `BrowserVault`. When the health-check request does not complete or fails, it never falls back to server file storage. A generated replacement version updates the matching item in the world list by ID, so a second card does not appear.

### The Flow of One Action

One action runs under one Web Lock, and the lock key is the vault database name plus the session ID. Other pages from the same origin must wait until the whole flow finishes. The IndexedDB transaction itself is never kept open across a network request.

1. First restore any pending result left over from before, then write the browser-generated input of this action into `BrowserVault`. Queued actions that have been replaced by a later action do not write new input.
2. `PUT /api/sessions/:id/browser-checkpoint` uses the latest full checkpoint to fill a temporary `MemoryStore` workspace on the server. If the server already has a validated workspace that holds persisted background jobs, it keeps the state owned by those jobs, and accepts only new player messages, session state and model settings, plus authorized world edits. When the response contains `reconcileRequired`, a `hydrate:<revision>` commit must be downloaded before continuing. Unsupported checkpoint changes return `409`.
3. Record the pending `actionId`, then run the normal action endpoint or the plugin-RPC endpoint against this workspace.
4. `POST /api/sessions/:id/browser-commit` exports the workspace result as a `SessionCommit` checked by revision number.
5. Dexie applies this commit atomically, and then clears the pending action. Replaying with the same `actionId` has no effect, including recovery after a crash between these two writes. A stale revision number, or a header with the same revision number but different content, is rejected.

**When it is persisted.**

- The client queues the checkpoint upload and the commit download in one line.
- SSE messages are shown right away but not persisted one by one. The checkpoint at the end of the action is the only persistent write.
- The terminal event of a background job requests one extra checkpoint only after the persisted worker has finished, so background work is not lost.
- The admission boundary for uploads also keeps the worker's result, even if the event was lost, or the worker finished exactly between the download and the upload.
- When a commit download fails, the pending action still exists after a page refresh. It must be recovered first, before the browser is allowed to upload an older checkpoint.

**Local changes use the same boundary.** Local checkpoint changes and session deletion follow the same ownership rules. New local input cannot push the revision number ahead of a result that has not been recovered yet. Closing a page releases its Web Lock, so another page can recover the pending result it left behind. Separate sessions do not share this lock. Remote mode (where the server is authoritative) still uses the server's coordination directly.

The "retry" and "skip" in the opening phase also go through this workspace exchange: the updated session state is committed first, and only then published to the interface. Recovery after a refresh works the same way.

### Lock Order for Worlds and Sessions

World ownership comes before session ownership.

- Every session operation in `LocalDataService` (including creating and deleting) first holds the world's shared Web Lock, and then holds its own session's exclusive lock. Reading the world to build a checkpoint is also within this boundary.
- Editing a world, replacing a generated world, and deleting a world: hold the world's exclusive lock. Preparing a world for the server: hold it shared.
- So a field patch is always merged into the latest world, and a session checkpoint cannot overwrite a world that was just edited at the same time with an old copy.
- Different sessions, because they share only the world lock, can still run in parallel.

**Deleting a world.** First wait for the session operations that have already been allowed to finish, then list the sessions, clean up their mirrors under the session lock, and finally delete the local domain records. A new session queued behind the deletion re-checks the world, and fails if the world is gone.

**Rules.**

- The lock order is always world first, then session. A workspace callback must not request the local world lock or session lock again recursively.
- The vault's low-level write methods rely on the ownership of this service layer, and they do not lock again inside an operation that already holds the lock.

**Saving a revision of a generated world.** A revision save replaces the whole record. It is not a field patch, and it is not merged with the old document.

- A revision save must also include the world that was fetched **before** the model request was sent. Inside the exclusive lock, the service compares this baseline with the latest public world shape (including the dimensions shown from metadata), ignoring the order of JSON object keys.
- If the world has changed or no longer exists, the stale result is rejected. It does not overwrite someone else's edits, and it does not bring a deleted world back.
- A first generation has no baseline, so it requires that the ID is not yet taken, checked under the same lock. This way it does not overwrite a world that another window created during generation.
- The generated content and its baseline are copied before any waiting I/O.

### Prerequisite: Web Locks

Browser-private mode needs Web Locks (HTTPS or localhost, and a browser that supports them). When they are not supported, a workspace error is reported before any action is sent. There is no unsafe fallback where "each tab manages itself". This coordination covers only pages of the same browser origin and the same vault. It does not involve other browsers or other origins.

### Scope and Version of Checkpoints

A `BrowserCheckpoint` contains every domain needed to restore a session: the session and world records, messages and the execution log, events and traces, characters, plugin data, the character schema, its own lorebook entries, interactions, suspensions, snapshots, and the lifecycle ledger.

Only the current format is supported. The envelope is schema v2. The storage boundary rejects checkpoints that lack the session clock fields, that have execution sources or states outside the canonical values, that carry old snapshot payloads, and that are schema v1.

## Browser Databases

The web app uses three databases, each with its own lifecycle:

- `covel-browser-vault` (Dexie schema v6): the latest session checkpoint, slim action idempotency records, pending server commits, browser-created worlds, and a persistent initialization marker.
- `covel-browser-cache` (native IDB schema v2): UI state, committed form blocks, the execution display cache, media metadata, and blobs used for rendering.
- `covel-browser-credentials` (Dexie schema v1): one-time session owner tokens, stored by session ID. Separate transactions let concurrent sibling writes avoid overwriting each other. Comparing against the token that was read at the time stops a late create or delete response from overwriting newly replaced credentials. Credentials do not go into the cache, and they are not part of a game or settings export. The old localStorage token table is not supported.

### Checking Session Credentials

After each attempt to delete a remote world, the client uses the tokens it read at that time to probe the session credentials it has stored. It deletes only the ones for which the server explicitly replies `session_not_found`.

- It does not conclude that a session does not exist just because it is "not in the filtered session list", and it does not record the world's ownership again in the credentials table.
- These probes share one three-second network deadline. On failure, unverified credentials and the original delete result are both kept.
- A newly created credential is persisted before its identity is verified. This way, a late create response can be matched with a delete cleanup that has already finished.
- A create result that is confirmed missing or replaced is treated as a failure. When it cannot be determined, the persisted credential is kept.
- This is not a transaction that spans the network.

### Interface Cache in Remote Mode

The remote interface cache has its own `remoteSessionUi` store, which records the session incarnation and the world ownership. `remoteUiEpochs` also holds short-lived operation epochs.

- Every cache read and write carries the caller's session identity.
- Reading, creating or replacing a binding queries the server. Updating the display under an already verified binding happens only locally.
- Every operation checks the epoch and the current cache binding inside one IndexedDB transaction. This way, a late response cannot overwrite a replacement with the same ID.
- Concurrent form submissions are merged.
- Local and remote timeline writes merge partial history by `(turnId, runtimeId)`, inside the same IndexedDB transaction as the write. An empty batch keeps the history. A lifecycle delete of a session or a world clears it explicitly.
- A matched row takes the new observation, including a change from "suspended" to "running". Status alone cannot establish an order across several tabs. Competing observations of the same row have no shared causal revision number, and that is outside this contract.
- When history is restored, the persisted reasoning content, tool identity and abort reason are kept.

### Ownership of Reads

Session restore, subscription refresh, and the loading of messages and the right-panel data share the ownership of "in-flight resources" within each provider instance.

- The session provider owns the initial values of plugin data. The right panel loads only the localized display definitions.
- A new read of the same resource replaces the old read.
- A committed event or snapshot publication invalidates overlapping pending observations. A read that is still current but gets invalidated is fetched again. A stale access stops right away, and a network error is thrown upward without a retry loop.
- A plugin snapshot is replaced as a whole per namespace, including removed entries.

Start, restore, reconnect, execution recovery and interaction submission all publish game state through the same ownership boundary.

- A committed state or character event that arrives during a restore invalidates its pending snapshot. An event that arrives after the snapshot was published schedules one follow-up restore. These signals are not cached for replay.
- When a background job reaches its terminal state, a browser checkpoint is triggered right after the session and access checks, before any buffering of interface restore. So restarting a display refresh does not lose a persistence step that must happen.
- When history is merged for the first time, existing messages with the same ID are kept.

### Joining History on Reconnect

Observations from a reconnect and from execution recovery keep the loaded history and its "older messages" cursor.

- If the latest snapshot and the loaded persisted messages do not overlap, the existing message API is used to page backward until the two windows join or the start of history is reached. The access and read ownership are checked between each page.
- When joining fails or makes no progress, nothing is published. The existing continuous window stays visible, an error is shown, and recovery is retried in read-only mode.
- Taking over a narrative in a terminal state clears only the streaming buffer of the matching turn and runtime. A newer, healthy POST stream still takes precedence.
- An explicit reload of the plugin directory shares the same provider resource ownership and the same access generation check as restore and reconnect reads.

A cached state patch fills the initial state only **before any authoritative snapshot arrives**. An authoritative snapshot, even an empty one, prevents deleted fields from being restored from the cache. Incremental character updates change the reducer state directly.

### Remote Deletion

Remote deletion invalidates the affected session or world epoch both before and after the server request, and it checks the cache's owners against the server's result. This holds when part of the operation fails too.

- An authentication error, a network error, or a missing identity marker: the data is kept.
- Confirmed not to exist, or a new incarnation has appeared: deletion is allowed.
- A cache error does not roll back the server's deletion.
- This protocol does not need Web Locks, and it does not guarantee that an offline client sees a deletion made on another device right away.

Local mode and remote mode use different cache stores, and ownership cannot move between them based on the session ID alone. Remote mode uses only the schema partitioned by the current identity. It offers no migration, no dual reads, and no fallback to an old display format. Reads and binding changes make one extra session GET, but streaming updates do not. Throughput of the two modes is not assumed to be the same.

### Example World

The example world is inserted only when a **newly created vault is initialized as an empty database for the first time**.

- The world record and the initialization marker are committed in the same IndexedDB transaction. So concurrent tabs do not insert it twice, and a failed write does not leave half of it behind.
- If initialization fails, the same service can retry it.
- After every world has been deleted, the marker remains, so the database stays empty after a refresh.
- Only the current vault schema is maintained. Old development-time vaults are rejected before the schema change is committed, and they must be explicitly rebuilt before they can be used. Nothing is migrated, and historical content is not cleared.
- An explicit full-database reset clears this marker along with the domain data.

### Forms and Timelines

Committed form block IDs and form values are merged in one IndexedDB read-write transaction.

- Each block from concurrent submissions (including those from different tabs) is kept. A later write to the same block replaces that block's value.
- Form input and timeline snapshots are copied before async storage. Changes the caller makes afterward do not alter a save that has already been requested.
- Deleting a session's "committed block" records is still the explicit reset method.

### Display History of State Changes

The display history of state changes is a read-through cache on IndexedDB. It is not a second, authoritative copy of the game state.

- When appending a record, the read and the write happen in the same read-write transaction, and records are deduplicated by event ID.
- A state patch keeps the `table.field` shape. The identity of a live event is `traceId` plus `seq`. When there is no valid pair, a UUID is used.
- There is no "one array per service" cache, so the history of other tabs is not overwritten, and stale read results are not kept.
- LocalDataService takes a snapshot for each append, holds the world and session ownership for the whole write, and checks after it is released that the session still exists. Local form and timeline writes use the same ownership and existence checks. Input is copied before waiting for release.
- A write queued after a deletion fails, and does not recreate the cache.
- Session deletion (including session cleanup during world deletion) releases ownership only after the patch, form and timeline cleanup finishes. A cleanup failure does not undo the domain deletion. It only goes through the existing development-time warning, and you can delete again to retry.
- Remote mode still uses the browser's form and timeline caches, but it does not have the ownership guarantees of this local vault. Cross-device form state and remote cache cleanup are not provided by this mechanism.
- Both modes merge different timeline rows transactionally. Competing observations of the same row still have no shared causal revision number.

### App KV and Connections

- Writes and deletes in the app KV are judged by whether the transaction completes, not by whether a single request succeeded. If a transaction aborts, it counts as a failure even if the request itself succeeded.
- The app KV and the optional render blob cache share one connection per page, and one opening operation in progress.
- A connection that failed to open and a handle that closed unexpectedly are discarded, and later operations can reconnect.
- When a version change notice arrives, the handle is closed and released so that a delete or an upgrade can proceed. It does not delete data, and it does not replay failed operations automatically.
- A blocked open fails immediately and does not wait forever. While the native request is still blocked, later calls reuse this failure instead of queuing a new open. An upgrade that is later abandoned is aborted, or its handle is closed.
- On error, the app KV reports the error. The render cache falls back to an authorized network response.
- IndexedDbMediaStore's explicit backend connection has its own lifecycle.
- A failure to persist a patch is returned to the caller. The SSE consumer reports it as a "best-effort display cache failure", and it does not change the committed game result.

### Render Blob Cache

- On read, the stored record and the expected media shape are validated. Invalid data counts as a miss.
- A deferred eviction is checked again inside the transaction, so it does not delete a valid replacement that another tab has just written.
- The decision "is this the first write" and the insert happen in the same read-write transaction. The first record is kept across tabs too.
- Writes and deletes wait for the transaction to complete. When it aborts, a safe diagnostic is produced without making the media rendering flow fail. Diagnostics do not include the raw browser error or signed URLs.
- This cache is only an optimization. It is not the authoritative source of media. Eviction by capacity is not yet implemented.

### Keeping Only the Latest Checkpoint

Only the latest full checkpoint is kept. The snapshot history is already inside the checkpoint, and keeping a full checkpoint for every action would make the size grow quadratically.

- The slim `commits` table stores the revision and action metadata, along with a fixed-length `sha256:` digest. The digest is computed over the checkpoint JSON after its keys are recursively sorted.
- Historical JSON commit digests are not supported. When the same action ID is replayed, a changed content is still rejected.
- The hash of a newly committed value is computed before its IndexedDB write transaction starts.
- The only version-change handler does one thing: it rejects an unsupported vault. It does not convert historical digests, and it does not write the initialization marker.

### No Credentials in Checkpoints

Before any transaction writes a checkpoint, `BrowserVault` recursively checks the session record (including `metadata`), and it rejects field names that look like credentials, such as `apiKey`, access/refresh tokens, passwords, private keys, and client secrets.

- Only the session record is checked, because that part is written by framework code. An owner token or a provider key could only leak in through there.
- The other domains and world records in a checkpoint are not checked. They hold the game content written by authors, models and plugins, and field names there are not restricted. (A character may have a `password` field.) If names were rejected there, the session could never be stored.
- Provider keys still travel only in request headers.

This development-time redesign does not import the removed `covel-browser` business schema. The old implementation can be found in Git history.

## Desktop Paths

Electron uses the web interface in remote mode, and business records are persisted in SQLite through the local server:

```text
~/.covel/
  config.toml
  llm.toml
  keys.env
  settings.json
  plugins/

<data_root>/                  # default ~/.covel/data
  covel.db
  worlds/
  logs/
  server.port
```

`[paths] data_root` moves SQLite, logs, the server port state, and user-created worlds together. Configuration and keys stay under `~/.covel/`. The Electron WebView may also create `covel-browser-cache`, but it never stores authoritative game records in it. For how to write each setting, see [Desktop configuration](../reference/desktop-config.md).

## Capabilities and Migrations

`/api/health.storage` reports:

- `data`: the server backend, its durability and the frontend mode;
- `media`: the configured and the actually effective media backend;
- `vector`: the configured vector mode and the specific driver;
- `migrations`: the server schema, plus the lightweight browser cache and media schemas.

The Dexie BrowserVault schema belongs to `apps/web`, and it is not reported externally as a migration of the server `DataStore`. `VECTOR_BACKEND=embedded` uses the capabilities of the current server store. BrowserVault deliberately does not implement vector retrieval.

## Prep Drafts and Session Lore

**Drafts.** The app KV overlay stored per world is an editing draft kept for later visits.

- Reads are tied to the current world and source text. They do not replace a newer edit or a reset.
- An empty string is a valid draft.
- When a read or write fails, a retry button and a safe operation diagnostic are shown. The lore text and the raw error are not logged.
- Creating a session waits for the first read to finish, or for the player to make an explicit edit. It does not depend on a draft write succeeding.

**How lore gets into a session.** The prep screen passes the lore text it displays directly to session creation.

- In local mode it is stored in the session metadata of the checkpoint. In remote mode it is created inside the server's session transaction.
- In both modes it is handed to the first server mirror before the lifecycle hooks run.
- When this session is started or restored, the world draft is no longer read.
- An existing session with no snapshot keeps using the world's lore, unless the API caller explicitly gives `start_session.loreOverride`.
- The creation-time snapshot uses the world record's lore schema, so long existing documents still work. An explicit action override keeps its limit of 500000 characters. The HTTP request size limit still applies. See [Session API](../reference/api.md#post-apisessions).

**Snapshots and forks.** A materialized snapshot records an optional override as `session.loreOverride`.

- A fork restores this value into the child session's metadata. Checkpoint transfer and repeated forks keep it, including an explicit empty string.
- Only this one gameplay field in the metadata carries over. Each child session gets a fresh ownership and lifecycle identity.
- Under the current contract, a missing field means the world's lore is used.
- An override that the snapshot did not record cannot be supplied by the metadata of a parent session that is still running. See [Snapshot and fork API](../reference/api.md#snapshot--fork).

## Record Identity

**Message IDs.**

- `addMessage` is a plain INSERT. In one DataStore, a message ID is unique across all sessions. A duplicate ID is rejected, and the original row is not replaced.
- `commitPlayerInputMessage` is a separate idempotent "accept input" path. Its semantics do not apply to a plain insert.
- The browser checkpoint validation rejects duplicate IDs in `checkpoint.messages` before it opens the replacement transaction. The same ID being used by another record domain is still valid.

**Updates do not change rows.** An update changes what a row holds. It does not replace it with another row:

- Updating an existing state entry keeps its ID.
- Worlds and lorebook entries keep their creation time.
- A re-saved suspension keeps its turn, runtime, plugin and creation time.

Memory, SQLite and PostgreSQL agree on this, and the shared contract tests check it.

**Suspensions.** A pending suspension stores the whole request it will continue: the messages up to the suspension point, the buffered tool calls and proposals, and the frozen input. On resume this record is sent out as it is, so none of it can be rebuilt from the session's later state.

- After the resume is committed, `markSuspensionResolved` keeps the row (duplicate resume requests and the session's suspension list still need to find it), and it discards what the resume has already consumed. A resolved row keeps only the execution identity, the language and the turn number (`settledSuspensionContinuation`).
- Snapshots copy only pending suspensions. So a resolved suspension never carries its prompts into snapshots, forks, exports or browser checkpoints.

**Append position.** When SQLite queries the append position of turn results, it uses the covering index `(session_id, created_at, seq)`. The startup DDL derives this index from the Drizzle schema. It keeps the existing sequence assignment and ordering. It does not limit how many execution artifacts are retained, and it is not a latency guarantee for production.

**Text cleanup.** Before persisting, every backend strips U+0000 from text and JSON content, including nested values. A record identifier that contains U+0000 is rejected, and so is a JSON key that would collide after cleanup. The insertion order of decimal values in lorebooks is kept. Ties in text ordering are broken by byte order. Dialogue rows with the same timestamp keep their insertion order.

**Sequence assignment.**

- PostgreSQL uses a separate sequence for each table to assign positions for messages, traces and turn artifacts, and this still works when several connections write at the same time.
- SQLite assigns them inside the write boundary it serializes.
- A gap in sequence numbers after a rollback is normal. When importing in order, new positions are assigned in the order of the import list. Cursor pagination and full lists use the same positions.
- The data schema metadata version is 4 for both SQL backends. Existing development databases must be rebuilt.

**Vector retrieval.** The results are first filtered by session, plugin and namespace, and then the top-K is picked exactly. Memory, SQLite and PostgreSQL all return Euclidean L2 distance. PostgreSQL materializes the filtered candidates instead of using a global approximate index, because the latter can miss matches after filtering.

**No diagnostic data in checkpoints.** A browser checkpoint does not contain the diagnostic trace payloads of LLM and hook calls, and it does not contain duplicate trace topic event rows. This diagnostic data is authoritative on the server. A checkpoint still carries gameplay state and execution recovery state. It is not an incremental checkpoint protocol.

**Identity of each kind of record.**

- World dimensions are normalized at the shared record boundary.
- A character's identity is `(sessionId, id)`.
- A lorebook entry's identity also includes its owner: the world, the player, or a specific plugin. A plugin can change only its own lorebook entries, even if another owner uses the same entry ID.
- Each session has one authoritative `characterSchema`. Character types are open, and attributes are validated.

MemoryStore, SQLite, PostgreSQL and browser checkpoints all keep these identities. So browser persistence and the server share the domain shape, but they do not share the server's table structures or each backend's create, read, update and delete implementations.

**Model routing.** Model routing looks at only three things: the slot settings, the request override, and the session's `runtimeModelOverrides`. A session does not carry a `presetId`, and this field is absent from session records, checkpoints and snapshots. Arbitrary session metadata cannot be used to choose a model. The identity and lock time of the embedding model are persisted on create and update, and all three backends agree.

## Current Snapshot Contract

**Saving the same snapshot again.** Saving the same snapshot ID again for the same session replaces the capture time (`createdAt`) along with the payload and the other refreshed fields. A full read, a time-ordered list, and newest-first metadata pagination all use the refreshed time in memory, SQLite and PostgreSQL. The snapshot ID and its owning session do not change. A transaction rollback restores both the previous payload and the capture time.

**Payload schema v3.** The following fields must exist: `characterSchema` (an object or null), `stateSchemas`, `runtimeExports`, `sessionSummaries`, `compactedMessageSummaryIds` and `displayMessagesBoundary`.

- An empty array, an empty map, and a chat boundary whose value is null are all explicitly collected values.
- A missing field is invalid, including old development-time payloads that carry the same version number. These snapshots must be rebuilt. There is no migration, and there is no fallback to the parent session's current state.
- Memory, SQLite and PostgreSQL validate the snapshot payload before writing. SQL reads and browser checkpoint validation use the same schema, including referential integrity of the collected summary references.
- The snapshot builder collects JSON-serialized data: properties whose value is undefined are omitted, and the live records in MemoryStore are not changed.
- Checkpoint export validates the stored branch ownership, but it does not repair rows that were historically divided by parent session.

Development caches that contain the old flat state patch need to be rebuilt. There is no compatibility read and no cache migration.

**Plugin extension migration.** This migration removed the working-memory table and the character plugin mirror. Memory blocks are now ordinary plugin-owned data. Affected development sessions, snapshots and browser checkpoints must be rebuilt, and old data is not migrated.

> [!WARNING]
> An existing SQLite database may fail at startup. The old `lorebook_entries` table uses `plugin_id`, while the current table and index need `owner`. `CREATE TABLE IF NOT EXISTS` does not change this table. The fix: stop the service, back up the database together with its `-wal` and `-shm` files, and then either switch to a new `SQLITE_PATH` or rebuild the development database. Creating new sessions in an old database is not enough. For the steps, see [development data migration](../reference/env-registry.md#plugin-extension-development-data).

## Server Settings

`server_settings` is a table that belongs to no session. It holds one row for each setting the server itself needs (`key`, `value`, `updated_at`). Write it with `setServerSetting` / `deleteServerSetting`, and read it with `listServerSettings`. Deleting a session does not affect it, and it is not included in snapshots or browser checkpoints. Every backend runs the same contract tests for it.

The value is JSON text. On SQLite and PostgreSQL it is stored in a `text` column, encoded by the shared query layer. `jsonb` is deliberately not used: the PostgreSQL driver parses every string it reads back from a `jsonb` column, so a stored string `"30"` would come back as the number `30`.

For which keys exist, who may write them, and how the web app uses them, see [`settings-store.md`](../reference/settings-store.md).

## Retention of Operational Records

The bookkeeping data of execution grows with every turn. The categories in the table below have limits. The ones listed after the table are kept for as long as the session exists.

| Record                                      | Limit                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind=auto` snapshots                       | One per `completedPlayerTurns` value (a later commit under the same count refreshes it). The newest `COVEL_AUTO_SNAPSHOT_RETENTION` (default 20) are kept, except snapshots recorded as the `parentId` of a branch. Manual snapshots and branch snapshots are never cleaned up.                                                                                       |
| Snapshot payloads and branches              | Do not contain the control-plane namespaces `_runtime_jobs`, `_runtime_job_control` and `_logs`. For snapshots taken before the exclusion rule took effect, they are also stripped when branching. Rows in the retired `_jobs` namespace are deleted at startup.                                                                                                      |
| `_runtime_jobs` and their `job_status` rows | Unfinished jobs are kept. For finished jobs, the newest 20 per runtime per session are kept.                                                                                                                                                                                                                                                                          |
| `_logs`                                     | A ring of 200 rows per plugin. It is trimmed the first time the logger writes, and then once every 20 writes, so one execution may briefly go over the limit.                                                                                                                                                                                                         |
| `trace_events`                              | 30 days by default (`COVEL_TRACE_RETENTION_DAYS`, where `0` keeps everything. When the variable is not set, the player's choice in Settings is used, stored in `server_settings`). Cleaned per session after each commit; cleaned for all sessions at startup and once a day after that. The rows of the latest turn are kept, because execution recovery reads them. |
| `events` (event records)                    | The same retention as `trace_events`, and cleaned in the same pass. The event bus stores a copy of every event it publishes, including the full value of every changed plugin data row. After an event is published, no code reads these rows again, except that another pod may fetch one oversized event by its ID.                                                 |

**Records kept with the session and deleted with it:** `turn_results`, `runtime_outputs`, `tool_calls`, `interactions`, `player_inputs`, state changes, each revision of runtime exports, and the logical turn ledger and opening-attempt ledger.

Each execution writes only one or a few rows for these, and they store results rather than prompts (the prompts are in `trace_events`). Each category has a place that reads older rows by name:

- A retry names a source turn.
- The media reference scan reads every turn result and runtime output.
- The debug API lists runtime outputs and interactions.
- The history of a state entry is its change rows.
- A background job reads the exports as they were at the moment its source execution started.

These rows are not copied in full into browser checkpoints (see [Browser-Private Protocol](#browser-private-protocol)). When to reconsider them: a server-stored session whose database is mostly taken up by these tables, rather than by messages, snapshots and traces. First look at `tool_calls` (no server code reads it) and at the export revisions older than the "earliest unfinished job".

**When a SQLite file gets smaller.** SQLite does not return the pages used by deleted rows to the file system, unless the file was created with `auto_vacuum = INCREMENTAL`.

- Databases created by the current version use this mode. Deleting traces is followed by a bounded `PRAGMA incremental_vacuum`, so the file shrinks after cleanup.
- A database file created earlier keeps its original mode. Freed pages are reused by new rows, so the file stops growing, but it does not shrink.
- To convert it, run a full `VACUUM` while the service is stopped (first set `PRAGMA auto_vacuum = INCREMENTAL` on the same connection). The server never does this during play.

**`turn_results` is the authoritative source of execution artifacts.**

- A retry rebuilds its seed from the full runtime results it saved (including effects and canonical values). The media reference scan also reads it directly.
- `runtime_outputs` is a narrower projection, used by the runtime output API.
- The old per-runtime `runtime_results` table duplicated these rows, and it is deleted at startup.
- A row is written before commit and settled by `setTurnResultCommitStatus`. When the turn commits successfully, it also rewrites results of discarded runtime writes to `failed` with an error attached, so a retry never seeds a discarded result as if it had succeeded.

## Plugin-Data Ownership and Reserved Names

The plugin-facing data API is bound to both the session ID and the plugin owner. A namespace is only a name inside that owner's partition, and it cannot be used to select a different owner. A plugin's ordinary writes are first buffered as proposals, and then committed under the identity of the originating owner.

**The order of lists is fixed.** Every plugin-data list is sorted by `(createdAt, pluginId, namespace, key)`, and the comparison is done by bytes on MemoryStore, SQLite and PostgreSQL (PostgreSQL uses `COLLATE "C"`).

- Rewriting a row changes only its value and `updatedAt`. Its `id` and `createdAt` do not change.
- Rows written by the same commit have the same `createdAt`. In that case the order is decided by the row's key, not by a random row ID.
- So lists that go into a prompt (world dimensions, a runtime's own data) are in the same order in every turn, in a branch, and in another run of the same scripted session.

Two more kinds of lists that go into a prompt also have a full order on every backend:

- `listCharacters` returns `(createdAt, id)`, and the IDs are compared by bytes. Without a specified order, PostgreSQL returns rows in their on-disk position, and rows that have been updated move. The world data importer gives the characters of one import creation times one millisecond apart, in the order the author wrote them, so this order is the order of the character roster. When a sync rewrites a character, it keeps the creation time.
- `listTurnMessages` and `listUncompactedTurnMessages` return `(createdAt, order, id)`. Two messages in the same millisecond are placed in pipeline order, with the player's message first.

**Who can read and write what.**

| Owner / namespace                                                                        | Who decides                                                                      | What a plugin can do                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin owner, any namespace starting with `_`                                            | The kernel                                                                       | Read through scoped APIs. No generic write or delete is allowed, and the same goes for unknown `_` names.                                                                                          |
| Plugin owner, `_runtime_jobs`                                                            | Persisted background jobs (detached stages, background manual or event triggers) | Read only. State transitions are handled by the runtime worker.                                                                                                                                    |
| Plugin owner, `_logs`                                                                    | The runtime log ring                                                             | Read only through the data API. Entries are produced through the scoped logger.                                                                                                                    |
| Plugin owner, `_hidden.<namespace>`                                                      | World data with `visibility: hidden`, and hidden content added during play       | Only the owning plugin's own code can read and write it (REST and LLM data tools cannot write). It does not appear in the public data API, extension handlers, LLM data tools or prompt injection. |
| Active dimension provider, `_dimensions`                                                 | Adopted definitions, current values and versions                                 | Read its own records. Writes only through `dimension.initialize` / `dimension.update` and validated batch CAS writes for import and sync.                                                          |
| Active dimension provider, `_dimension-settlements`                                      | Obligations and receipts of narrative settlement                                 | Read its own records. Source registration is handled by the host, and state transitions must be validated. No generic write.                                                                       |
| Plugin owner, `message`                                                                  | The plugin                                                                       | Ordinary proposal-based data. The interface host prefetches it for declared message panels and forwards it, without interpreting its business shape.                                               |
| Plugin owner, ordinary names such as `blocks`, `definitions`, `characters`, `blueprints` | The plugin                                                                       | Read its own data, and write it through proposals. Old character mirrors are not created again.                                                                                                    |
| `__kernel:<subsystem>` owners, including `__kernel:vector` and `__kernel:triggers`       | The kernel                                                                       | Not visible through a bound plugin's store or extension API, the REST reads of plugin data, or the `plugin-data.changed` event. This is an owner partition, not a plugin namespace.                |

**The whole underscore prefix is reserved.** If only the names that exist today were listed as exceptions, bookkeeping data added by the kernel in the future could become writable by plugins before every caller has been updated.

- `_memory` is still protected, even though the old memory mirror and queue have been removed. This does not mean there is a compatibility read or data recovery.
- Jobs and logs keep their existing snapshot and branch inclusion policy.
- Kernel-owned rows (such as each runtime's trigger ledger) travel with snapshots, branches and checkpoints, just like the session's other plugin data.

**Dimension data.** Dimension records and receipts use the existing `plugin_data`. They are not a new table, and they are not a mirror of `state_entries`.

- The definition and the current value share one versioned record.
- A receipt keeps the frozen source definition and the version it was read at. It does not copy narrative text.
- Snapshot, branch and BrowserVault checkpoint transfers keep both the data and the pending obligations.
- The public session view exposes only the current value entries and receipt summaries. It never exposes maintenance rules or initial values.

See [World Model](../reference/world-model.md#dynamic-dimension-snapshot) and [batch CAS](../reference/transactions.md#versioned-plugin-data-batch-cas).

> [!NOTE]
> These are permission boundaries at the API level. They are not encryption, and they are not a process sandbox.

**Stability commitment**: keeping the `_` prefix is a permanent design decision. New kernel subsystems may add more `_<name>` namespaces, and that is not a breaking change. Plugin authors must never put their own data in the `_` namespace, and they must not assume that they can write names reserved by the kernel.

### Bounded Reads

**Execution reads.**

- `queryTurnResults` (which returns only root artifacts) and `queryTraceEvents` filter before the payload is decoded.
- Turn artifacts persist `retryScope`, independent of the trace retention period. When timestamps are equal, insertion order is kept.
- `queryPluginData` supports reading a namespace across sessions through an index, plus an optional filter on top-level strings. The dimension barrier requests only pending receipts. The worker's maintenance work shares one snapshot of the queue.
- Wake-up signals received while this snapshot is being read or maintained stay in the queue until the next round. Reconciliation advances only to the snapshot's "started reading" time.
- `deleteEventsBefore` provides explicit retention for the event log.

This changes the development database schema (`turn_results.retry_scope`, log positions, and the decimal order of lorebook entries in PostgreSQL). Affected development databases must be rebuilt. No migration from the old schema is provided.

**Message index in MemoryStore.** MemoryStore keeps a global "message ID → offset" map next to the message array.

- A plain insert rejects an ID that is already taken. Adopting player input keeps its own separate idempotent contract.
- Appending and adopting look up identities directly. They do not scan the accumulated conversation.
- Transactions and savepoints snapshot both structures together. When a session is deleted, the remaining offsets are rebuilt once.
- This does not limit the cost of a full checkpoint import, collection snapshots, or history reads. Those still grow with the amount of stored data.

**Prompt reads have limits.** Reads that go into a prompt are bounded in size at the storage boundary.

- `getLatestPlayerInput(sessionId)` selects one form submission ordered by `createdAt` descending, with ID byte order as the tiebreak. So execution admission does not need to load the whole input log.
- `getPluginDataPromptWindow(sessionId, pluginId, namespace, maxEntries)` returns `{ entries, total }`. When the count is within the limit, entries are returned in creation order. When it exceeds the limit, the earliest half is taken, plus the rest of the most recently updated entries, with duplicate anchors removed.
- The SQL backends count without loading JSON, and they apply the entry limit before decoding records. MemoryStore implements the same selection rule and ownership contract.
