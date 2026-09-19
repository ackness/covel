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

| Value    | Use                                               | Notes                                                                      |
| -------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| `memory` | tests and browser-private execution               | Process-local and lost on restart. Health reports `frontendMode: "local"`. |
| `sqlite` | desktop, local development, single-node self-host | Uses `SQLITE_PATH`; default `./data/covel.db`.                             |
| `pg`     | hosted and multi-process deployment               | Requires `DATABASE_URL`; session locks use PostgreSQL advisory locks.      |

`STORE_BACKEND=idb` and `createStore({ backend: "idb" })` do not exist.

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

The browser is authoritative in local mode. The server may read API keys from
request headers and execute a turn, but it must not durably persist the player's
checkpoint or credentials.

One action follows this sequence under a Web Lock keyed by the vault database and
session ID. Other documents in the same origin wait for the complete exchange;
the IndexedDB transaction itself is never held open over network I/O.

1. Recover any previous pending result, then persist this action's browser-authored
   input to `BrowserVault`. Superseded queued actions do not persist new input.
2. `PUT /api/sessions/:id/browser-checkpoint` hydrates an ephemeral `MemoryStore`
   workspace with the latest full checkpoint.
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
an additional checkpoint so detached work is not lost. If a commit download
fails, the pending action survives a page reload and must be recovered before
the browser is allowed to upload an older checkpoint.

Local checkpoint edits and session deletion use the same ownership boundary;
new local input cannot advance a revision ahead of an unrecovered result. A closed
document releases its Web Lock, allowing another document to recover its pending
result. Independent sessions do not share this lock. Remote/server-authoritative
mode continues to use server coordination directly.

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
again inside an existing operation. Explicit generated-world saves replace the
entire record; they are not field patches or a merge of stale documents.

Browser-private execution requires Web Locks (HTTPS or localhost in a supported
browser). Missing support produces a workspace error before any action is
dispatched; there is no unsafe per-tab fallback. This coordination is scoped to
documents sharing the browser origin and vault, not unrelated browsers or origins.

`BrowserCheckpoint` includes every domain needed to resume a session: session
and world records, message/execution journals, events/traces, characters,
plugin data, memory/lorebook data, interactions, suspensions, snapshots, and
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
Initial history merges retain current messages with the same ID. Cached state patches fill initial state only before any authoritative snapshot
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

`BrowserVault` recursively rejects credential-shaped fields such as `apiKey`,
access/refresh tokens, passwords, private keys, and client secrets before any
transaction writes. Ordinary domain content whose name happens to be
`secret`/`secrets` (for example `CharacterBlueprint.persona.secrets`) is not a
credential and remains persistable. Provider keys continue to travel only in
request headers.

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

World dimensions are normalized at the shared record boundary. Character and
lorebook IDs are session-local, with durable
identity `(sessionId, id)` in MemoryStore, SQLite, PostgreSQL, and browser
checkpoints. Browser persistence therefore shares domain shapes without sharing
server table layouts or backend-specific CRUD implementations.

Model routing uses slot settings, request overrides and session
`runtimeModelOverrides`. Sessions do not carry a separate `presetId` selection;
the former field never participated in execution and has been removed from
session records, checkpoints and snapshots. Arbitrary session metadata does not
supply model selection. Embedding model identity and lock time persist on create
as well as update across MemoryStore, SQLite and PostgreSQL.

## Current Snapshot Contract

Snapshot payload schema v3 requires `stateSchemas`, `runtimeExports`,
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
