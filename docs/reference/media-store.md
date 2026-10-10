# MediaStore

`MediaStore` persists generated images, audio, video, and files behind a content-addressed `MediaRef`.

## Contract

Every backend implements:

```ts
interface MediaStore {
  put(blob: Uint8Array | Blob, mime: string, meta?: object): Promise<MediaRef>;
  get(ref: MediaRef): Promise<Uint8Array | Blob>;
  exists(id: string): Promise<boolean>;
  resolveUrl(ref: MediaRef): Promise<string>;
  delete(id: string, opts?: { force?: boolean }): Promise<void>;
  lookup(id: string): Promise<MediaAssetLookup | null>;
  recordOwnership(
    id: string,
    ownerSessionId: string,
    ownerPluginId?: string,
  ): Promise<void>;
  addRef(id: string, sessionId: string, pluginId?: string): Promise<void>;
  removeRef(id: string, sessionId: string): Promise<void>;
  isReferencedBy(id: string, sessionId: string): Promise<boolean>;
  listAssets(): Promise<readonly MediaAssetRecord[]>;
  listByMetadata(
    sessionId: string,
    filter: Readonly<Record<string, unknown>>,
  ): Promise<readonly MediaAssetRecord[]>;
  listRefs(): Promise<readonly MediaRefRecord[]>;
  cleanup(
    protectedIds: ReadonlySet<string>,
    policy?: MediaLifecyclePolicy,
  ): Promise<MediaCleanupResult>;
  openReadStream?(ref: MediaRef): Promise<ReadableStream<Uint8Array>>;
  close?(): void | Promise<void>;
}
```

`put()` computes a SHA-256 id from the bytes and deduplicates repeated content. The first stored metadata wins for duplicate content.

Metadata JSON removes U+0000 on all four backends without mutating the caller's
object. Keys that would collide after cleaning are rejected before publication.
Binary bytes, including zero bytes, remain unchanged and determine the digest.

## HTTP content safety

`POST /api/media` accepts image uploads and normalizes the MIME type/subtype to
lowercase without parameters before storing it. SVG uploads are rejected because
SVG can execute scripts when opened on the application origin. MIME comparison is
case-insensitive and ignores parameters, so `image/SVG+xml; charset=utf-8` is also
rejected.

Uploads authorize the same session record used to capture its immutable
incarnation. Before binding ownership and references, the session lock rechecks
the owner, incarnation, active status, and deletion marker. A concurrent owner
change is rejected with `401`; an incarnation change or inactive/deleting session
returns `409`. Bytes stored before rejection remain unbound and eligible for GC.

`GET /api/media/:id` applies `Content-Disposition: attachment` and
`Content-Security-Policy: sandbox` to stored SVG assets, including historical or
producer-written MIME values with mixed casing or parameters. Both ordinary
responses and `304` cache revalidation responses carry these protections.

## Backends

The Web render-blob cache is separate from the `MediaStore` backend. Web media
resolution authorizes the session before consulting this cache. Cache records are validated;
malformed or mismatched entries fall back to verified network bytes. Concurrent
writes retain the first record using one IndexedDB transaction. Write/delete
completion follows transaction completion, and cache failures emit diagnostics
without turning successfully downloaded media into a rendering failure.

Render-cache and app-KV operations share one browser connection per page. Failed
opens and closed handles can be retried by a later operation; version changes
release the old handle. A blocked open returns a failure promptly and abandons
its eventual upgrade/connection. Until that native request settles, later calls
reuse its failure instead of queuing another blocked open. Cache diagnostics
exclude raw exception details and signed URLs. Invalid-record eviction rechecks the current record before
deleting, preserving another tab's valid replacement.

| Backend         | Factory                                         | Byte storage                                           | `openReadStream()`          |
| --------------- | ----------------------------------------------- | ------------------------------------------------------ | --------------------------- |
| Memory          | `createMemoryMediaStore()`                      | Process memory                                         | yes (single chunk)          |
| SQLite/local-fs | `createSqliteMediaStore(dbPath, { mediaRoot })` | Local files under `{mediaRoot}/{ab}/{cd}/{sha256}.bin` | yes (true streaming)        |
| PostgreSQL      | `createPgMediaStore(databaseUrl)`               | `media_assets.body` as `bytea`                         | **no** — see "PG streaming" |
| IndexedDB (web) | `createIndexedDbMediaStore({ dbName })`         | Browser IDB Blob store                                 | yes (Blob.stream())         |

### PG streaming caveat

`createPgMediaStore` intentionally does **not** implement `openReadStream`. The `bytea` column type forces the entire blob into memory before the driver can hand it back, so a "streaming" wrapper would just buffer the whole asset and add no value over the eager `get()` path. The route layer in `apps/server/src/routes/api/media.ts` already gates on `typeof store.openReadStream === 'function'` and falls back to `get()` automatically — no caller change is required.

If you store media larger than a few MiB on PostgreSQL, consider moving bytes to
SQLite local-fs (`createSqliteMediaStore`) and keeping PG for the rest of the
kernel state.

## Media Wire Registries (image / speech / transcription / music)

Media _generation_ (as opposed to storage) routes through pluggable wire
registries in `@covel/ai-provider` (`packages/ai-provider/src/image/wire-registry.ts`,
`packages/ai-provider/src/speech/wire-registry.ts`), upstream of `MediaStore` —
generated bytes land in `MediaStore` via `ctx.images.generate()` /
`ctx.speech.generate()` / `ctx.music.generate()` only after a wire produces
them.

- Each wire implements one provider's request/response shape. Builtin wires:
  `openai-images` (default, `DEFAULT_IMAGE_WIRE`) and `dashscope-wan` for image;
  `openai-speech` (TTS, `POST /audio/speech`) and `openai-transcription`
  (STT, `POST /audio/transcriptions`) for speech. Music
  (`packages/ai-provider/src/music/wire-registry.ts`) has no builtin wire:
  providers share no request format, so a plugin registers one. A wire whose
  provider answers with a job polls inside `compose` and returns the audio.
- Wire selection is per-slot: `llm.toml` `[covel.<slot>].providerRequestMetadata`
  keys `imageWire` / `speechWire` / `transcriptionWire` / `musicWire` set the
  wire id; unset values fall back to the builtin defaults, and `musicWire` has
  none, so an unset one is a configuration error. An unknown id throws at generation
  time rather than silently falling back. See [slots.md](./slots.md).
- Plugins register additional wires from their `entry` module via
  `covel.registerWires({ image?, speech?, transcription?, music?, text? })` (ids auto-namespaced
  `<pluginId>/<wireId>`; trust-gated loading) — see
  [plugin-extensions.md § 模型与新协议](plugin-extensions.md#模型与新协议).
  Bundled code can also call `registerImageWire` / `registerSpeechWire` /
  `registerTranscriptionWire` directly — open string ids, not enums.

## Metadata Conventions & Querying

`put()`, `ctx.media.put()`, and `ctx.images.generate()` all accept a free-form `meta` object stored alongside each asset. Two kinds of keys live in that object:

- **Business keys** — plugin-defined, describe what the image _is_: `kind` (`scene-background` / `character-sprite` / `illustration` / …), `sceneId` or `characterId`, `variant` (`day` / `night` / …). The framework never reads these; they exist purely for the querying plugin's own convention.
- **Framework keys** — `pluginId` and `promptHash`, injected automatically by `ctx.images.generate()` (`packages/runtime/src/function-runtime/runtime-images-context.ts`) and `ctx.speech.generate()` (`runtime-speech-context.ts`). They are spread onto `meta` **after** the caller-supplied `metadata`, so a plugin can never override them.

### `listByMetadata(sessionId, filter)`

Returns assets owned by `sessionId` whose `meta` contains every key/value in `filter` — an exact, shallow subset match, one shared implementation (`filterAssetsByMetadata` in `packages/store/src/media-store/filter.ts`) reused by all four MediaStore backends. A `filter` value of `undefined` matches both a missing key and a key explicitly stored as `undefined` (`meta[k] === v` — both sides read `undefined`). Only primitive values (string/number/boolean/`null`) compare meaningfully; objects and arrays never match because `===` on them is reference equality. Result sets are expected to stay small — per-session media volume is tens of records, so this is a full scan (`ponytail:` comment in `filter.ts` — push down to SQL when volume outgrows that). `filter.ts` is kept free of Node built-ins (unlike `utils.ts`) because the explicit browser MediaStore imports it.

### `promptHash` idempotency

`ctx.images.generate()` derives `promptHash` deterministically from the generation parameters (`prompt`, `negativePrompt`, `size`, `quality`, `n`, `background`) and the resolved provider, model, protocol, endpoint and canonical wire metadata. It resolves the current image binding before cache lookup; rebinding the same role to another model or wire invalidates the cache. API keys, authentication headers, business `metadata`, and `signal` are excluded. `ctx.speech.generate()` uses the same model identity with (`presetId`, `text`, `voice`, `format`), and `ctx.music.generate()` with (`presetId`, `prompt`, `lyrics`, `instrumental`, `durationSeconds`, `format`): a line or a piece made by one model is not served after the role is bound to another, and is served again when the role returns to the first model. Speech and music serve one stored asset as the cached result. Before calling the gateway it queries `listByMetadata(sessionId, { promptHash, pluginId })`; if at least `n` matching assets already exist (speech: 1), it returns those refs with `cached: true` and skips the provider call entirely. Two calls with the same prompt but different `metadata` therefore dedupe to the same cached asset — the metadata stamped on disk is whatever the **first** call supplied, each returned cached ref carries the current call's business metadata while the persisted asset retains the first call's metadata. A partial hit (fewer than `n` existing assets, e.g. one image failed to persist on a prior call) is **not** served as cached — it regenerates the full batch rather than silently handing back fewer images than requested.

## Ownership

SQLite/local-file `put()` writes complete bytes to an exclusive temporary file in the target directory, atomically renames it to the content path, then registers metadata. A retry replaces an orphan final file without metadata rather than trusting its existence; failed writes remove their temporary file.

`recordOwnership()` sets the first owner for an asset (first-writer-wins; a second call with a different `sessionId` does not overwrite it). `addRef()` grants another session read access for fork and snapshot flows; `removeRef()` idempotently removes one session's explicit ref (does not delete bytes or ownership metadata). `isReferencedBy()` returns true for the owner session and for sessions with an explicit reference row. `ctx.media.put()` and `ctx.media.ingestUrl()` record ownership and the session's reference after the bytes are stored; when the runtime or guard that called them was aborted or timed out meanwhile, the call rejects and records neither, and the unowned bytes are left to media cleanup.

`GET /api/sessions/:id/media-token` requires the session owner credential on
hosted tiers and in production with MemoryStore, including the `self`
browser-private profile. An operator credential can authorize the request as
with other session routes. The session must also own or reference the requested
asset before the server issues a signed media URL.

`POST /api/media` accepts `image/*` MIME types and rejects `image/svg+xml`.
MIME type checks ignore case, surrounding whitespace, and parameters; accepted
uploads store the lowercase type without parameters. Reads apply the same
normalization before checking historical asset metadata: SVG assets are always
served with `Content-Disposition: attachment` and `Content-Security-Policy:
sandbox`, on both buffered and streaming responses. The stored MIME parameters
remain available in the read response's `Content-Type`.

`delete()` removes every inbound ref before the asset. SQL backends perform both
steps in one transaction; in particular, a second SQLite process cannot insert
a ref between the ref cleanup and asset deletion.

`addRef()` is **idempotent on `(sessionId, mediaId)`** — the `media_refs` UNIQUE constraint ignores `plugin_id` (which is recorded as first-source metadata only). This is the safe behaviour because SQL `UNIQUE` treats every `NULL` as distinct, so a constraint that includes a nullable `plugin_id` would silently allow unbounded duplicate rows when callers passed `undefined`. The new key shape matches Memory and IndexedDB, which use `(sessionId, mediaId)` as their map key.

Only the current `(session_id, media_id)` constraint is supported. Recreate
development databases that use the former media-reference shape; the framework
does not migrate or automatically delete old rows.

`put(bytes, mime, meta?, initialRef?)` can create an initial reference in the
same critical section/transaction that publishes the bytes, including when the
content already exists. It does not assign ownership. The reference follows the
usual `(sessionId, mediaId)` first-writer-wins rule and is visible to cleanup
before `put` returns.

World-data preparation uses this operation to pin bytes under a unique
`world-data-import:<uuid>` reference. The colon is outside the accepted user
session-ID alphabet. Each import attempt therefore owns separate temporary
references even when concurrent attempts target the same session and content.
Finalization establishes the real session's ownership/ref before releasing the
temporary references. Preparation, semantic-write, duplicate-session, and world
admission failures release only the current attempt's temporary references;
they never force-delete shared content or release an existing session's claims.
Unclaimed bytes are then eligible for lifecycle GC. If a newly created session
fails media finalization, creation deletes that session and releases its claims
under the session lifecycle lock. Sync removes explicit references after commit
and leaves ownership/byte reclamation to lifecycle GC.

If semantic data has committed but finalization fails, the temporary reference
remains until permanent claims can be recovered. Session creation releases it
after a successful rollback; a failed rollback also retains the pin.
Temporary-reference release is best-effort and logs failures without changing
the import outcome. A process crash or release failure can leave a temporary
reference behind; cleanup conservatively retains its bytes. These references
have no automatic expiry. An operator must establish that the import is no
longer active before manually removing an abandoned temporary reference. No
persistent schema change or development-data recreation is required.

## Lifecycle Cleanup

The SQLite media factory owns its shared connection reference until construction
succeeds. Initialization failure releases only that reference, preserves other
owners and rethrows the original error. After success, the returned store's
`close()` owns release; the connection closes when its last owner releases it.

The framework exposes `POST /api/media/cleanup` for manual cleanup and scheduler integration. The route scans live sessions, messages, plugin data, runtime outputs, trace events, snapshots, turn results, `MediaStore.listAssets()`, and `MediaStore.listRefs()` with the shared `collectMediaRefIds()` scanner, then passes the protected id set into `MediaStore.cleanup()`.

`protectedIds` is a planning snapshot, not the final deletion authority. Cleanup
also includes every current ownership/ref claim in its plan, including temporary
import references, so dry runs report pinned assets as protected. Every
backend rechecks the asset's current owner and reference rows in the same
critical section/transaction as deletion (PG advisory transaction lock +
`NOT EXISTS`, SQLite `BEGIN IMMEDIATE`, IndexedDB two-store `readwrite`, Memory
synchronous map check). A reference or owner created after the route scan
therefore retains the asset; the returned cleanup counters/ids are reconciled
to what was actually deleted rather than the stale plan.

SQLite keeps its `BEGIN IMMEDIATE` lock through removal of the content file,
preventing a concurrent same-digest `put()` from recreating bytes before an old
deletion finishes. An unlink failure rolls back metadata and reference removal.
Physical `delete()` and non-dry-run `cleanup()` must run outside an existing SQL
transaction; they reject before changing metadata or refs when the shared
connection already has one open. Callers run them after their DataStore
transaction settles. A filesystem unlink cannot be undone by an outer SQL
rollback. This restriction does not apply to `put()` or a cleanup dry run, which
may use the shared connection inside a DataStore transaction.

The endpoint is unavailable in `commercial` deployments. In `demo`, it
requires the configured operator bearer token before feature-flag or policy
evaluation; `self` keeps the local single-user behavior.

Cleanup policy fields:

| Field             | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `dryRun`          | Defaults to `true`; returns the deletion plan while keeping bytes in place    |
| `maxAgeMs`        | Deletes unprotected assets created at or before `now - maxAgeMs`              |
| `maxBytes`        | Deletes oldest unprotected assets until total stored bytes fit the cap        |
| `keepRecentBytes` | Keeps the newest unprotected byte budget and selects older unprotected assets |

An empty policy returns an inventory-style dry run with zero selected deletions. Desktop and web media reads use the same authoritative store metadata, with browser cache entries validated against the `MediaRef` before serving.

## Tests

The shared contract lives in `packages/store/src/contract/media-store-contract.ts`. Current coverage runs against Memory, SQLite/local-fs, IndexedDB (via `fake-indexeddb`), and PostgreSQL when `DATABASE_URL` points at a reachable database (`packages/store/tests/media-store.test.ts`).
