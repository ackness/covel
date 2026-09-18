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

The web app uses two databases with separate lifecycles:

- `covel-browser-vault` (Dexie schema v5): latest session checkpoints, compact
  action-idempotency records, pending server commits, and browser-authored
  worlds with a durable initialization marker.
- `covel-browser-cache` (native IDB schema v1): UI state, submitted blocks,
  execution-display cache, media metadata, and render blobs.

Sample worlds are inserted only when a newly created vault first initializes
an empty library. The world records and initialization marker commit in one
IndexedDB transaction, so concurrent tabs cannot seed duplicates and a failed
write leaves no partial set. Initialization failures may be retried by the same
service. Deleting every world preserves the marker and keeps the library empty
after reload. Schema v5 upgrades mark existing libraries initialized, including
empty ones, preserving user deletions rather than guessing whether to add
samples. An explicit full vault reset clears the marker along with domain data.

Submitted block IDs and form values merge in one IndexedDB readwrite
transaction. Concurrent submissions, including writes from separate tabs,
retain each block; a later write to the same block replaces that block's values.
Removing the session's submitted-block record remains the explicit reset path.

State-change display history is an IndexedDB read-through cache, not a second
authoritative game-state store. Appending one record reads and writes within one
readwrite transaction; there is no per-service array cache to overwrite another
tab's history or retain stale reads. LocalDataService snapshots each append and
holds world/session ownership through the write, checking that the session still
exists after admission. An append queued behind deletion fails without recreating
the cache. Deletion waits for patch/submitted-block cleanup to settle before
releasing ownership; cleanup failures are reported and do not undo domain deletion.

App-KV writes and deletions resolve on transaction completion, not individual
request success. An aborted transaction rejects even if its request succeeded.
Callers receive patch persistence failures; the SSE consumer reports them as
best-effort display-cache failures without changing the committed game outcome.

Only the latest full checkpoint is retained. Snapshot history already exists
inside the checkpoint; retaining a full checkpoint for every action would grow
quadratically. The compact `commits` table stores revision/action metadata and
a fixed-length `sha256:` digest of the recursively key-sorted checkpoint JSON.
BrowserVault schema v4 converts v3's historical JSON strings into these digests
one record at a time in an atomic upgrade transaction. Checkpoints, worlds and
pending recovery markers remain intact; replayed action IDs still reject changed
content. Hashing new commits completes before their IndexedDB write transaction.

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

## Record Identity

World dimensions and session preset/model fields are normalized at the shared
record boundary. Character and lorebook IDs are session-local, with durable
identity `(sessionId, id)` in MemoryStore, SQLite, PostgreSQL, and browser
checkpoints. Browser persistence therefore shares domain shapes without sharing
server table layouts or backend-specific CRUD implementations.
