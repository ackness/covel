# Storage Architecture

Covel uses deployment profiles, not one oversized storage adapter across every
runtime. Domain records keep one wire contract, while each environment uses the
database SDK that matches its constraints.

| Profile           | Durable authority                              | Execution store                | Intended deployment                                |
| ----------------- | ---------------------------------------------- | ------------------------------ | -------------------------------------------------- |
| `browser-private` | Dexie `BrowserVault` in the player's IndexedDB | Ephemeral server `MemoryStore` | Public demo pages and browser-only self deployment |
| `desktop`         | Server `SqliteStore`                           | Same SQLite store              | Electron and single-user local installs            |
| `cloud`           | Server `PgStore`                               | Same PostgreSQL store          | Hosted and multi-process deployments               |

The shared contracts are intentionally narrower than the old four-backend
`DataStore` abstraction:

| Category                         | Contract                              | Implementations                                         |
| -------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Server business records          | `DataStore`                           | memory, SQLite, PostgreSQL                              |
| Browser-private business records | `BrowserCheckpoint` / `SessionCommit` | Dexie `BrowserVault`                                    |
| Binary assets                    | `MediaStore`                          | memory, SQLite, PostgreSQL, explicit browser IDB cache  |
| Frontend UI/cache data           | app KV and media cache                | lightweight native IndexedDB                            |
| Preferences and credentials      | settings/config contracts             | localStorage, Electron IPC, desktop/server config files |

`IdbStore` was removed. Browser code no longer implements every server CRUD and
transaction method a second time. `@covel/store` owns the domain record and
checkpoint contracts; `apps/web` owns the browser persistence mechanism.

## Server Backend Selection

`STORE_BACKEND` selects only the server `DataStore`:

| Value    | Use                                               | Notes                                                                                 |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `memory` | tests and browser-private execution               | Process-local and lost on restart. Health reports `frontendMode: "local"`.            |
| `sqlite` | desktop, local development, single-node self-host | Uses `SQLITE_PATH`; default `./data/covel.db`. Driver: Node's built-in `node:sqlite`. |
| `pg`     | hosted and multi-process deployment               | Requires `DATABASE_URL`; session locks use PostgreSQL advisory locks.                 |

`STORE_BACKEND=idb` and `createStore({ backend: "idb" })` do not exist. An unknown
value (`postgres` for `pg`, say) stops the start with an error that lists the accepted
values; the same holds for `MEDIA_BACKEND` and `VECTOR_BACKEND`.

One server process owns a SQLite file. `createStoreFromEnv()` creates `<SQLITE_PATH>.lock`
exclusively, holding the owner's pid and start time, and removes it when the store closes
or the process exits. A second process (the desktop app and a dev server on the same
Covel home, say) fails at start with a message naming the file and the owner's pid. A lock
whose pid is not alive is stale and is taken over; a process that opens the same file twice
is not a conflict. Code that opens a database file directly with `createStore()`, such as
tests, tools and read-only scripts, takes no lock. The memory and `pg` backends take none.

`MEDIA_BACKEND` remains independent. `mirror` follows the selected server data
backend; explicit browser IDB is a media/cache implementation, not a business
`DataStore`.

PostgreSQL coordinates database writes, session locks and EventBus fan-out across
processes. Active-turn steering and cancellation still use process-local execution
handles; requests must reach the instance executing that turn. Legacy background
jobs and durable staged jobs also have different restart guarantees. The
[API deployment capability matrix](../reference/api.md#多实例能力边界) records
these limits; selecting PostgreSQL does not provide transparent execution failover.

World settings and memory block schemas are read from the operation's current
DataStore. There is no process-wide world-record cache: committed edits and
same-ID replacements become visible on the next read, and independent stores
cannot share world records accidentally. Runtime settings remain captured for
each operation, so subsequent edits do not mutate an in-flight snapshot.

Archival vector deletion requires successful reads of both character and lorebook
sources. A source read failure aborts that archival sweep, retains existing
vectors and content hashes, and emits the existing session-correlated warning.
A successful empty source is authoritative and still removes obsolete entries;
the next healthy sweep can reuse unchanged hashes without another embedding call.

## Memory index ownership

`MemorySystem` owns its background tasks. Hosts stop producers, call that
instance's `drain()`, and inspect `pendingTaskCount()` before closing its store.
Independent instances never share a process-global drain barrier.

Archival vector queries validate their candidates against current character and
lorebook records before returning content. Deleted or changed candidates cause a
keyword fallback until asynchronous ingestion refreshes the index. Lorebook API
writes also schedule ingestion. Deleting one archival source deletes only that
vector key and retains unchanged vectors without another embedding call.

Recall cursors and archival hashes live in `vector_index_progress`, alongside
physical indexes, rather than `plugin_data`. Progress writes compare the previous
serialized value and validate the session incarnation under the backend's write
boundary. Session deletion/replacement clears both progress and vectors; a
transaction rollback restores the progress. Business snapshots, forks and browser
checkpoints never copy it and therefore rebuild their own indexes.

This changes the development storage contract. Recreate existing development
databases and browser checkpoints containing the former index-owned `plugin_data`
records; there is no legacy read, migration or sentinel-filter compatibility path.

The `@covel/store` root exports contracts and lazy factories. Explicit backend
constructors use `/memory`, `/sqlite`, `/postgres` and `/indexeddb`; importing a
lightweight contract or factory does not load all native backend drivers.

## Server World and Session Deletion

The world DELETE API owns cascade orchestration. It claims a persisted deletion
lease under a short `world:<id>` lock, releases that lock, and deletes each save
through the same lifecycle path as session DELETE. That path drains writers and
background work, runs SessionEnd, releases media references, and clears transient
session state. The world record and generated package are removed only after no
sessions remain. Raw `DataStore.deleteWorld` only removes the world record.

Session creation, forks, and checkpoint replacement commit under session locks
followed by world locks. World deletion never holds a world lock while waiting
for a session or running hooks. World edits, new sessions, forks, and checkpoint
replacement reject worlds marked for deletion; seed and file reload also honor
the marker and re-read disk content after acquiring the lock. All server paths
use the backend-selected `SessionLock`, including PostgreSQL advisory locks.

The cascade is not one transaction across every session. Failed cleanup preserves
the world with a retryable marker; another DELETE resumes remaining work. A stale
lease can be reclaimed after ten minutes. Clients cannot set or clear the reserved
`metadata.worldDeletion` field. Session creation and fork require an existing,
non-deleting world when a world ID is supplied; worldless sessions remain valid.

Browser Web Locks below coordinate a separate client-owned workspace. Remote
browser display caches remain the frontend's responsibility.

## Browser-Private Protocol

BrowserVault schema 6 stores a small session head beside each checkpoint. The
head contains the session record, revision and commit time; checkpoint writes,
commit application and deletion update it in the same IndexedDB transaction.
Session lists and lock ownership checks read these heads without decoding
conversation history. Earlier development vaults must be recreated; there is no
migration or fallback to reading old checkpoint rows.

A checkpoint travels whole in both directions at every action, so it holds only
what does not grow with each turn played, plus the conversation itself. All game
state, messages and the prompt history are complete. Of the execution journals
it carries the turn results and runtime outputs of the latest 40 executions (a
retry names a recent turn as its source), the newest revision of each runtime
export (while a background job is unfinished, also the revision that was live
when the earliest such job's source execution began and every later one, since
the job reads its exports as of that instant), and the `turn.started` /
`turn.completed` / `turn.failed` trace rows that the execution status is read
from. The tool-call log, the event trail and every other trace row have no
reader outside the debug page and stay in the server workspace that produced
them; the debug page of a private session therefore shows no model calls.

The upload is limited to 64 MiB of JSON (`BROWSER_CHECKPOINT_MAX_BYTES` in
`@covel/store/browser-sync`), and a session past it cannot go on: the protocol
has no partial upload. The web client measures the body of each upload and, from
80% of the limit, tells the player once per session and page load, so the story
can be continued in a new session before uploads are refused with `413`.

The browser is authoritative in local mode. The server may read API keys from
request headers and execute a turn, but it must not durably persist the player's
checkpoint or credentials.

World generation waits for a successful storage capability check before choosing
its save target. Browser-private generation uses `return-only` and persists the
result in `BrowserVault`; an unfinished or failed health request never falls
back to server-file storage. A generated replacement updates the world list by
ID instead of appending a second card.

One action follows this sequence under a Web Lock keyed by the vault database and
session ID. Other documents in the same origin wait for the complete exchange;
the IndexedDB transaction itself is never held open over network I/O.

1. Recover any previous pending result, then persist this action's browser-authored
   input to `BrowserVault`. Superseded queued actions do not persist new input.
2. `PUT /api/sessions/:id/browser-checkpoint` hydrates an ephemeral `MemoryStore`
   workspace with the latest full checkpoint. When an existing verified workspace
   contains durable detached jobs, it retains worker-owned state and admits only
   new user messages, session status/model settings, and authorized world edits.
   The `reconcileRequired` response requires a staged `hydrate:<revision>` commit
   download before continuing. Unsupported checkpoint edits return `409`.
3. Record the pending `actionId`, then execute the normal action or plugin-RPC
   endpoint against that workspace.
4. `POST /api/sessions/:id/browser-commit` exports the resulting workspace as a
   revision-checked `SessionCommit`.
5. Dexie applies the commit atomically, then clears the pending action. Replaying
   the same `actionId` is a no-op, including recovery after a crash between these
   writes; stale revisions and same-revision divergent heads are rejected.

The client serializes checkpoint uploads and commit downloads. SSE messages are
rendered immediately but are not persisted one by one; the post-action
checkpoint is the single durable write. Terminal background-job events request
an additional checkpoint only after the durable worker settles, so detached work
is not lost. The upload admission boundary also preserves worker results when
events are missed or a worker finishes between download and upload. If a commit download
fails, the pending action survives a page reload and must be recovered before
the browser is allowed to upload an older checkpoint.

Local checkpoint edits and session deletion use the same ownership boundary;
new local input cannot advance a revision ahead of an unrecovered result. A closed
document releases its Web Lock, allowing another document to recover its pending
result. Independent sessions do not share this lock. Remote/server-authoritative
mode continues to use server coordination directly.

Setup Retry and Skip use this same workspace exchange and commit their updated
session state before publishing it to the UI, including recovery after reload.

World ownership precedes session ownership. Each `LocalDataService` session
operation, including creation and deletion, holds a shared world Web Lock and
then its exclusive session lock. World reads for checkpoint construction happen
inside this boundary. World edits, generated-world replacement and world
deletion hold the exclusive world lock; preparing the server world uses shared
ownership. Field patches therefore merge with the latest world, and a session
checkpoint cannot overwrite a concurrently edited world with an old copy.
Different sessions retain parallel execution through shared world ownership.

World deletion drains admitted session operations before enumerating sessions,
cleans up their mirrors under session locks, then removes local domain records.
New session creation queued behind deletion rechecks the world and fails if it
is gone. Lock acquisition always follows world then session; workspace callbacks
must not recursively request local world or session locks. The low-level vault
write methods rely on this service-level ownership, rather than acquiring locks
again inside an existing operation. Generated-world revision saves replace the
entire record; they are not field patches or a merge of stale documents.
Revision saves additionally supply the world captured before the model request.
Inside exclusive ownership, the service compares that baseline with the latest
public world shape (including dimensions surfaced from metadata), ignoring JSON
object key order. A changed or missing world rejects the stale result without
overwriting edits or resurrecting a deletion. Initial generation has no revision
baseline and requires an unused ID inside the same lock; it cannot overwrite a
world another window created during generation. Both generated content and its
baseline are copied before awaiting I/O.

Browser-private execution requires Web Locks (HTTPS or localhost in a supported
browser). Missing support produces a workspace error before any action is
dispatched; there is no unsafe per-tab fallback. This coordination is scoped to
documents sharing the browser origin and vault, not unrelated browsers or origins.

`BrowserCheckpoint` includes every domain needed to resume a session: session
and world records, message/execution journals, events/traces, characters,
plugin data, character schemas, owned lorebook entries, interactions, suspensions, snapshots, and
lifecycle ledgers. The current-only envelope is schema v2; it rejects missing
session clock fields, non-canonical execution origins/statuses, old snapshot
payloads, and schema v1 checkpoints at the storage boundary.

## Browser Databases

The web app uses three databases with separate lifecycles:

- `covel-browser-vault` (Dexie schema v5): latest session checkpoints, compact
  action-idempotency records, pending server commits, and browser-authored
  worlds with a durable initialization marker.
- `covel-browser-cache` (native IDB schema v2): UI state, submitted blocks,
  execution-display cache, media metadata, and render blobs.
- `covel-browser-credentials` (Dexie schema v1): one-time session owner tokens,
  keyed by session ID. Independent transactions prevent concurrent sibling writes
  from overwriting each other; captured-token comparisons protect replacement
  credentials from delayed create/delete responses. Credentials are excluded from
  caches and game/settings exports. The old localStorage token map is unsupported.

After any remote world deletion attempt, the client probes its stored session
credentials with their captured tokens and removes only explicit per-session
`session_not_found` responses. It does not infer absence from a filtered session
listing or duplicate world ownership in the credential table. A shared three-second
network deadline bounds these probes; failures preserve both unverified credentials
and the original deletion result. Newly created credentials are persisted before
identity verification, so a late creation response can reconcile with completed
deletion cleanup. Confirmed missing/replaced creation results fail; uncertain
verification retains the durable credential. This is not a cross-network transaction.

Remote UI caches have a separate `remoteSessionUi` store with session incarnation
and world ownership, plus short operation epochs in `remoteUiEpochs`. Cache reads
and writes capture the caller's session identity. Reads and new/replaced bindings
query the authoritative server; display updates under an already verified binding
stay local. All operations validate epochs and the current cache binding inside
an IndexedDB transaction.
This prevents delayed responses from overwriting a same-ID replacement. Concurrent
form submissions merge. Local and remote timeline writes merge partial history by
`(turnId, runtimeId)` inside the same IndexedDB transaction as the write. An empty
batch preserves history; session/world lifecycle deletion clears it explicitly.
Matching rows use the incoming observation, including suspended-to-running
transitions. Status alone cannot establish order across tabs; a shared causal
revision for competing observations of the same row remains outside this contract.
History restoration retains persisted reasoning, tool identity and abort reason.

Session restoration, subscription refresh, and message/right-panel hydration share
in-flight resource ownership within each provider instance. The session provider
owns plugin-data seeds; the right panel loads only localized display definitions.
New reads replace older reads of the same resource. Committed events and snapshot
publication invalidate overlapping pending observations. A current invalidated read
fetches again; obsolete visits stop and network errors propagate without a retry
loop. Plugin snapshots replace their namespaces, including deleted entries.

Start, restore, reconnect, execution recovery, and interaction submission publish
game state through the same ownership boundary. Committed state/character events
received during recovery invalidate its pending snapshot; an event arriving after
snapshot publication schedules one subsequent recovery. These signals are not
buffered for replay. Terminal background-job notifications trigger their browser
checkpoint immediately after session/visit validation, before any UI recovery
buffering; restarting a display refresh cannot discard the required persistence.
Initial history merges retain current messages with the same ID.

Reconnect and execution-recovery observations retain the loaded history and its
older-message cursor. If the recent snapshot does not overlap loaded durable
messages, they page backward through the existing message API until the windows
connect or the start of history is reached, checking visit and read ownership
between pages. A failed or non-advancing bridge is not published: the existing
continuous window remains visible, an error is shown, and read-only recovery
retries. Terminal narrative takeover clears only the matching turn/runtime
streaming buffers; a newer healthy POST stream remains authoritative. Explicit
plugin catalogue reloads share the same provider resource ownership and
visit-generation checks as restore and reconnect reads.

Cached state patches fill initial state only before any authoritative snapshot
has arrived; an empty authoritative snapshot still prevents deleted fields from
being restored from the cache. Character increments update reducer state directly.

Remote deletion invalidates the affected session/world epoch before and after the
server request and reconciles cached owners against the server, including partial
failure. Authentication/network errors or missing identity tags preserve data; confirmed absence or a new
incarnation allows removal. Cache errors do not roll back server deletion. This
protocol needs no Web Locks and does not make offline clients immediately observe
deletion performed by another device.

Local and remote modes use distinct cache stores; a session ID alone cannot transfer
ownership between them. Remote mode uses only the current identity-scoped schema.
No migration, dual-read or fallback to previous remote display formats is provided.
Reads and binding changes add a session GET; streaming updates do not. No throughput
equivalence is assumed.

Sample worlds are inserted only when a newly created vault first initializes
an empty library. The world records and initialization marker commit in one
IndexedDB transaction, so concurrent tabs cannot seed duplicates and a failed
write leaves no partial set. Initialization failures may be retried by the same
service. Deleting every world preserves the marker and keeps the library empty
after reload. Only the current vault schema is maintained; old development vaults
are rejected before a schema change commits and must be recreated explicitly
before use. No historical content is migrated or cleared. An explicit full
vault reset clears the marker along with domain data.

Submitted block IDs and form values merge in one IndexedDB readwrite
transaction. Concurrent submissions, including writes from separate tabs,
retain each block; a later write to the same block replaces that block's values.
Form inputs and timeline snapshots are copied before asynchronous storage work,
so caller mutations cannot change an already requested save.
Removing the session's submitted-block record remains the explicit reset path.

State-change display history is an IndexedDB read-through cache, not a second
authoritative game-state store. Appending one record reads and writes within one
readwrite transaction and deduplicates by event ID. State patches retain their
`table.field` shape; live event identity uses `traceId` plus `seq`, with a UUID
when a valid identity pair is unavailable. There is no per-service array cache to overwrite another
tab's history or retain stale reads. LocalDataService snapshots each append and
holds world/session ownership through the write, checking that the session still
exists after admission. The same ownership and existence check applies to local
form and timeline writes; inputs are copied before waiting for admission.
Writes queued behind deletion fail without recreating the cache. Session deletion,
including world deletion's session cleanup, waits for patch/form/timeline cleanup
before releasing ownership. Cleanup failures do not undo domain deletion; they
use the existing development warning path and can be retried by deleting again.
Remote mode still uses browser form/timeline caches without this local-vault
ownership guarantee; cross-device form state and remote cache cleanup are not
provided by this mechanism. Both modes merge distinct timeline rows transactionally;
competing observations of the same row still have no shared causal revision.

App-KV writes and deletions resolve on transaction completion, not individual
request success. An aborted transaction rejects even if its request succeeded.
App-KV and the optional render-blob cache share one connection and in-flight open
per page. It discards failed opens and unexpectedly closed handles so a later operation can reconnect. A version-change
notification closes and releases that handle to allow deletion or upgrades;
it does not delete data or automatically replay the failed operation. Blocked
opens reject instead of waiting indefinitely. While that native request remains
blocked, later calls reuse the rejection instead of queuing another open. Any
later abandoned upgrade is aborted or its handle closed. App-KV reports the error; the render cache
falls back to the authorized network response. IndexedDbMediaStore's explicit
backend connection has its own lifecycle.
Callers receive patch persistence failures; the SSE consumer reports them as
best-effort display-cache failures without changing the committed game outcome.

Render-blob cache reads validate the stored record and expected media shape.
Invalid data is a miss; deferred eviction rechecks inside a transaction so it
cannot remove a valid replacement from another tab. First-write detection and
insertion share a readwrite transaction, preserving the first record across tabs.
Cache writes/deletions wait for transaction completion, and aborts produce safe
diagnostics without rejecting the media rendering flow. Diagnostics omit raw
browser errors and signed URLs. The cache is an optimization, not media authority.
Capacity-based eviction remains unimplemented.

Only the latest full checkpoint is retained. Snapshot history already exists
inside the checkpoint; retaining a full checkpoint for every action would grow
quadratically. The compact `commits` table stores revision/action metadata and
a fixed-length `sha256:` digest of the recursively key-sorted checkpoint JSON.
Historical JSON commit digests are unsupported. Replayed action IDs still reject
changed content. Hashing new commits completes before their IndexedDB write
transaction. The sole version-change handler rejects unsupported vaults; it does
not convert historical digests or write initialization markers.

Before any transaction writes a checkpoint, `BrowserVault` recursively rejects
credential-shaped field names in its session record (`metadata` included), such
as `apiKey`, access/refresh tokens, passwords, private keys, and client secrets.
The session record is the part framework code writes, so it is where an owner
token or a provider key could leak in. The check does not read the other
checkpoint domains or the world record: they hold game content from authors,
models and plugins, whose field names are unrestricted (a character may have a
`password` field), and a name-based rejection there would be permanent for that
session. Provider keys continue to travel only in request headers.

This development-version redesign does not import the removed `covel-browser`
business schema. Old implementations remain recoverable from Git history.

## Desktop Paths

Electron uses the web UI in remote mode and persists business records through
the local server's SQLite store:

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

`[paths] data_root` moves SQLite, logs, server port state, and user-authored
worlds together. Config and secrets remain under `~/.covel/`. The Electron
WebView may still create `covel-browser-cache`, but never stores authoritative
game records there.

## Capabilities And Migrations

`/api/health.storage` reports:

- `data`: the server backend, durability, and frontend mode;
- `media`: configured and effective media backend;
- `vector`: configured vector mode and concrete driver;
- `migrations`: server schemas plus the lightweight browser cache/media schema.

The Dexie BrowserVault schema is owned by `apps/web` and is not advertised as a
server `DataStore` migration. `VECTOR_BACKEND=embedded` uses the active server
store capability; BrowserVault intentionally does not implement vector search.

## Prep Drafts and Session Lore

The world-keyed app-KV overlay is an editing draft for later visits. Reads are
owned by the current world/source text and cannot replace a newer edit or reset.
Empty strings are valid drafts. Read/write failures expose retry controls and
safe operation diagnostics without logging lore or raw errors. Creation waits
for the initial read or an explicit edit, but does not depend on draft writes.

Prep passes its displayed lore directly to session creation. Local mode saves
it in checkpoint session metadata; remote mode creates it in the server's
session transaction. Both pass it to the initial server mirror before lifecycle
hooks. Beginning or restoring that session does not read the world draft again.
Existing sessions without a snapshot continue using world lore unless an API
caller explicitly supplies a `start_session.loreOverride`. Creation snapshots
use the world-record lore schema so existing long documents remain usable;
explicit action overrides keep their existing 500000-character limit. HTTP
request size limits still apply. See [session API](../reference/api.md#post-apisessions).

Materialized snapshots capture the optional override as `session.loreOverride`.
Fork restores that value into child metadata, and checkpoint transfer and repeated
forks preserve it, including an explicit empty string. Only this gameplay field
travels from metadata; each child receives fresh ownership and lifecycle identity.
An absent field selects world lore in the current contract. The live parent's
metadata must not supply an override the snapshot did not capture. See [snapshot and fork API](../reference/api.md#snapshot--fork).

## Record Identity

`addMessage` is an ordinary INSERT: message IDs are unique across all sessions
in one DataStore, and a duplicate ID rejects without replacing the original
row. `commitPlayerInputMessage` is the separate idempotent input-adoption path;
its semantics do not apply to ordinary inserts. Browser checkpoint validation
rejects repeated IDs within `checkpoint.messages` before opening the replacement
transaction; IDs reused by a different record domain remain valid.

An update changes what a row holds, not which row it is: updating an existing
state entry keeps its ID, a world or lorebook entry keeps its creation time, and
a re-saved suspension keeps its turn, runtime, plugin and creation time. Memory,
SQLite and PostgreSQL agree on this; the shared contract suite checks it.

SQLite's turn-result append-position query uses the covering index
`(session_id, created_at, seq)`. The boot DDL derives that index from the Drizzle
schema. This preserves existing sequence allocation and ordering; it does not
bound execution-artifact retention or establish a production latency guarantee.

Text and JSON content lose U+0000 before persistence on every backend, including nested values. Record identifiers containing U+0000 are rejected; cleaning JSON keys that would collide is also rejected. Fractional lorebook insertion order is preserved. Text tie-breakers use byte order, and same-timestamp conversation rows retain insertion order.

PostgreSQL allocates message, trace and turn-artifact positions with per-table
sequences, including simultaneous connections. SQLite allocates under its
serialized write boundary. Sequence gaps after rollback are valid; sequential
imports assign fresh positions in the imported list order. Cursor pages use the
same positions as full lists. The data-schema metadata version is 4 on both SQL
backends; existing development databases must be recreated.

Vector search applies session/plugin/namespace filters before exact top-K selection. Memory, SQLite and PostgreSQL return Euclidean L2 distance. PostgreSQL materializes the filtered candidates rather than using a global approximate index that can lose hits after filtering.

Browser checkpoints exclude diagnostic LLM/hook trace payloads and duplicate trace-topic event rows. The server remains the source for these diagnostics. Checkpoints still carry gameplay and execution recovery state; this is not an incremental checkpoint protocol.

World dimensions are normalized at the shared record boundary. Character identity
is `(sessionId, id)`. Lorebook identity also includes its owner: world, player, or
a specific plugin. A plugin can modify only its own lore entries, including when
another owner uses the same entry ID. Each session has an authoritative
`characterSchema` with open character types and validated attributes. These
identities are preserved by MemoryStore, SQLite, PostgreSQL, and browser checkpoints. Browser persistence therefore shares domain shapes without sharing
server table layouts or backend-specific CRUD implementations.

Model routing uses slot settings, request overrides and session
`runtimeModelOverrides`. Sessions do not carry a separate `presetId` selection;
the former field never participated in execution and has been removed from
session records, checkpoints and snapshots. Arbitrary session metadata does not
supply model selection. Embedding model identity and lock time persist on create
as well as update across MemoryStore, SQLite and PostgreSQL.

## Current Snapshot Contract

Saving the same snapshot ID for its existing session replaces the capture time
(`createdAt`) together with the payload and other refreshed fields. Full reads,
chronological lists and newest-first metadata pages use that refreshed time on
Memory, SQLite and PostgreSQL. Snapshot IDs and session ownership stay unchanged;
a transaction rollback restores both the previous payload and capture time.

Snapshot payload schema v3 requires `characterSchema` (object or null), `stateSchemas`, `runtimeExports`,
`sessionSummaries`, `compactedMessageSummaryIds` and `displayMessagesBoundary`.
Empty arrays/maps and a null chat boundary are explicit captured values. Missing
fields are invalid, including older development payloads carrying the same version.
Recreate those snapshots; no migration or fallback to current parent state is provided.
Memory, SQLite and PostgreSQL validate snapshot payloads before writes; SQL reads
and browser checkpoint validation use the same schema, including captured summary
reference integrity. The snapshot builder captures JSON-serialized data, omitting
undefined object properties without mutating live MemoryStore records. Checkpoint
export validates stored fork ownership without repairing historical parent-scoped rows.

Development caches containing the former flat state-patch shape must be recreated;
no compatibility reader or cache migration is provided.

The plugin-extension migration removes the working-memory table and character
plugin mirrors. Memory blocks are ordinary plugin-owned data. Recreate affected
development sessions, snapshots and browser checkpoints; old data is not migrated.
An existing SQLite database can also fail during startup: older
`lorebook_entries` tables use `plugin_id`, while the current table and indexes
require `owner`. `CREATE TABLE IF NOT EXISTS` does not change that table. Stop
the server, back up the database together with any `-wal` and `-shm` files,
then use a new `SQLITE_PATH` or recreate the development database. Creating only
new sessions in the old database is insufficient. See the
[development migration steps](../guide/env-registry.md#plugin-extension-development-data).

## Server Settings

`server_settings` is a table that belongs to no session: one row per setting
the server itself acts on (`key`, `value`, `updated_at`), written through
`setServerSetting` / `deleteServerSetting` and read with `listServerSettings`.
Deleting a session leaves it alone, and it is not part of a snapshot or a
browser checkpoint. Every backend passes the same contract suite for it.

The value is JSON text in a `text` column on SQLite and PostgreSQL alike, encoded
by the shared query layer. It is deliberately not `jsonb`: the PostgreSQL driver
layer parses every string it reads from a `jsonb` column, so the stored string
`"30"` would come back as the number `30`. Which keys exist, who may write them
and how the Web app uses them: [`settings-store.md`](../reference/settings-store.md).

## Retention Of Operational Records

Execution bookkeeping grows with every turn, so each kind has an explicit bound:

| Record                                      | Bound                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind=auto` snapshots                       | One per `completedPlayerTurns` value (later commits at the same count refresh it); the newest `COVEL_AUTO_SNAPSHOT_RETENTION` (default 20) are kept, except snapshots a fork names as `parentId`. Manual and fork snapshots are never pruned.                                                                  |
| Snapshot payload and forks                  | Omit control-plane namespaces `_runtime_jobs`, `_runtime_job_control` and `_logs`; a fork also drops them from snapshots taken before they were excluded. Rows of the retired `_jobs` namespace are deleted at boot.                                                                                           |
| `_runtime_jobs` and their `job_status` rows | Unfinished jobs are kept; terminal jobs keep the newest 20 per session runtime.                                                                                                                                                                                                                                |
| `_logs`                                     | Ring of 200 rows per plugin, trimmed on a logger's first write and every 20th after, so one execution can briefly exceed it.                                                                                                                                                                                   |
| `trace_events`                              | 30 days by default (`COVEL_TRACE_RETENTION_DAYS`, `0` keeps all; the player's Settings choice, stored in `server_settings`, applies when the variable is unset). Pruned per session after a commit, and for every session at start and once a day. The newest turn's rows stay: execution recovery reads them. |     |

SQLite does not return the pages of deleted rows to the file system unless
the file was created with `auto_vacuum = INCREMENTAL`. A database created by
this version is, and the trace delete is followed by a bounded
`PRAGMA incremental_vacuum`, so the file shrinks after a sweep. A database file
created earlier keeps its mode: its freed pages are reused by new rows, so it
stops growing, but it does not get smaller. Converting it takes a full
`VACUUM` with the server stopped (set `PRAGMA auto_vacuum = INCREMENTAL` on the
same connection first); the server never runs one during play.

`turn_results` is the authoritative execution artifact: retries rebuild their
seeds from its full runtime results, including effects and canonical values,
and media reference scans read it directly. `runtime_outputs` is the narrower
projection behind the runtime-output API. The former per-runtime
`runtime_results` table duplicated those rows and is dropped at boot.
Rows are written before commit; `setTurnResultCommitStatus` settles them, and
on a committed turn it also rewrites the results of runtimes whose writes were
dropped to `failed` with their error, so retries never seed a dropped result as
a success.

## Plugin-data ownership and reserved names

Plugin-facing data APIs bind both session ID and plugin owner. A namespace is a
name inside that owner's partition, not a way to select another owner. Ordinary
plugin writes are buffered as proposals and committed under the source owner.

Every plugin-data list returns rows in `(createdAt, pluginId, namespace, key)`
order, compared byte by byte on MemoryStore, SQLite and PostgreSQL (PostgreSQL
with `COLLATE "C"`). A rewrite changes a row's value and `updatedAt` only: its
`id` and `createdAt` stay. Rows written in one commit share a `createdAt`, so the
row key decides their order and the row ID, which is random, does not. Lists that
reach a prompt (world dimensions, a runtime's own data) are therefore in the same
order from turn to turn, in a fork, and in another run of the same scripted
session.

Two more lists that reach a prompt have a total order on every backend.
`listCharacters` returns `(createdAt, id)`, IDs compared byte by byte; without
an order PostgreSQL returned rows as they lay on disk, where an updated row
moves. The world-data importer gives the characters of one import creation
times one millisecond apart, in the order the author wrote them, so that order
is the roster's; a sync that rewrites a character keeps its creation time.
`listTurnMessages` and `listUncompactedTurnMessages` return
`(createdAt, order, id)`: two messages of one millisecond come in pipeline
order, the player's message first.

| Owner / namespace                                                                        | Authority                                                                      | Plugin access                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin owner, any `_`-prefixed namespace                                                 | Kernel                                                                         | Read through the scoped APIs; no generic writes or deletes, including unknown `_` names.                                                                                                |
| Plugin owner, `_runtime_jobs`                                                            | Durable background jobs (detached stages, background manual/event activations) | Read only; runtime workers own transitions.                                                                                                                                             |
| Plugin owner, `_logs`                                                                    | Runtime log ring                                                               | Read only through data APIs; entries are produced through the scoped logger.                                                                                                            |
| Plugin owner, `_hidden.<namespace>`                                                      | `visibility: hidden` world data and hidden content added in play               | Read and written only by the owning plugin's own code (REST and LLM data tools cannot write); excluded from public data APIs, extension handlers, LLM data tools, and prompt injection. |
| Active dimension provider, `_dimensions`                                                 | Adopted definitions, current values and versions                               | Read own records; writes only through `dimension.initialize` / `dimension.update` and validated import/sync batch CAS.                                                                  |
| Active dimension provider, `_dimension-settlements`                                      | Narrative settlement obligations and receipts                                  | Read own records; host-owned source registration and verified settlement transitions, not generic writes.                                                                               |
| Plugin owner, `message`                                                                  | Plugin                                                                         | Ordinary proposal-backed data; the UI host prefetches and forwards it for declared message panels without interpreting its business shape.                                              |
| Plugin owner, ordinary names such as `blocks`, `definitions`, `characters`, `blueprints` | Plugin                                                                         | Read own data and write through proposals. The old character mirrors are not recreated.                                                                                                 |
| `__kernel:<subsystem>` owner, including `__kernel:vector` and `__kernel:triggers`        | Kernel                                                                         | Not visible through plugin-bound store or extension APIs, plugin-data REST reads or `plugin-data.changed` events. This is an owner partition, not a plugin namespace.                   |

The full underscore prefix remains reserved. Enumerating today's names as
exceptions would allow future kernel bookkeeping to become plugin-writable before
all callers were updated. `_memory` stays protected even though the old memory
mirror and queue were removed; no compatibility reads or data restoration are
implied. Jobs and logs retain their existing snapshot/fork inclusion policies.
Kernel-owned rows such as the per-runtime trigger ledger travel with snapshots,
forks and checkpoints like the rest of the session's plugin data.
Dimension records and receipts use existing `plugin_data`, not a new table or a
`state_entries` mirror. Definitions and current values share a versioned record;
receipts retain frozen source definitions/read versions without copying narrative
text. Snapshot, fork and BrowserVault checkpoint transfers preserve both data
and pending obligations. Public session views expose only current-value entries
and receipt summaries, never maintenance rules or initial values. See
[World Model](../reference/world-model.md#动态维度快照) and
[batch CAS](../reference/transactions.md#versioned-plugin-data-batch-cas).

These are API authority boundaries, not encryption or a process sandbox.

**Stability commitment**: The `_` prefix reservation is a permanent design decision.
New kernel subsystems may introduce
additional `_<name>` namespaces without breaking changes. Plugin authors must never
rely on `_` namespaces for their own data or assume they can write to kernel-reserved
names.

Execution reads use `queryTurnResults` (root artifacts only) and `queryTraceEvents` to filter before decoding payloads. Turn artifacts persist `retryScope` independently of trace retention and preserve insertion order for timestamp ties. `queryPluginData` supports indexed namespace reads across sessions and optional top-level string filtering; the dimension barrier requests only pending receipts, and worker maintenance shares one queue snapshot. Wakes received while that snapshot is read or maintained remain queued for the next pass, and reconciliation advances only through the snapshot's read-start time. `deleteEventsBefore` provides explicit event-log retention. This changes the development database schema (`turn_results.retry_scope`, log positions, and PostgreSQL fractional lore order); recreate affected development databases. No old-schema migration is provided.

MemoryStore keeps a global message-ID-to-offset map alongside its message array.
Ordinary inserts reject occupied IDs; player-input adoption keeps its separate
idempotency contract. Append/adoption identity lookups do not scan the accumulated
conversation. Transactions and savepoints snapshot both structures, and session
deletion rebuilds surviving offsets once. This does not bound whole checkpoint
imports, collection snapshots or history reads independently of stored data size.

Prompt reads are bounded at the storage boundary. `getLatestPlayerInput(sessionId)` selects one form submission ordered by descending `createdAt` and byte-ordered ID, so execution admission does not load the input log. `getPluginDataPromptWindow(sessionId, pluginId, namespace, maxEntries)` returns `{ entries, total }`: below the cap it returns creation order; above the cap it selects the oldest half plus the most recently updated remainder, excluding duplicate anchors. SQL backends count rows without loading JSON and apply limits before record decoding. MemoryStore implements the same selection and ownership contract.
