# Media Storage

`MediaStore` is where Covel keeps media files: generated images, audio, video, and other files. Each file you save gets a `MediaRef`. After that, messages, plugin data, and the interface store only this reference, not the file content.

This page covers its interface, the storage modes, who can read a file, when a file can be deleted, and the media library that players see in Settings. It is for people who write a storage backend, write a plugin that generates media, or run a server.

Two terms are used throughout this page:

- **Owner**: The first session that saved the file.
- **Reference (ref)**: Another session that declares "I also need this file".

## Contract

Every backend implements the interface below:

```ts
interface MediaStore {
  put(
    blob: Uint8Array | Blob,
    mime: string,
    meta?: object,
    initialRef?: { sessionId: string; pluginId?: string },
  ): Promise<MediaRef>;
  get(ref: MediaRef): Promise<Uint8Array | Blob>;
  exists(id: string): Promise<boolean>;
  delete(id: string): Promise<void>;
  lookup(id: string): Promise<MediaAssetLookup | null>;
  recordOwnership(
    id: string,
    ownerSessionId: string,
    ownerPluginId?: string,
  ): Promise<void>;
  addRef(id: string, sessionId: string, pluginId?: string): Promise<void>;
  claimAssets(
    claims: readonly { id: string; sessionId: string; pluginId?: string }[],
  ): Promise<void>;
  removeRef(id: string, sessionId: string): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
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

The types are defined in `packages/shared/src/types/media.ts`.

Plugins use `ctx.media.put()` to store bytes, `ctx.media.get()` to read bytes, and `ctx.media.ingestUrl()` to download and store media. `get()` only reads files that the calling session owns or references. To display media in the UI, pass a `MediaRef` and let the framework handle reading it.

**A file's ID is a hash of its content**

- `put()` computes a SHA-256 from the file content and uses it as the ID. Files with the same content are stored only once.
- When the same content is stored again, the metadata from the first save is kept.

**U+0000 in metadata**

- Memory, SQLite and PostgreSQL all remove the U+0000 character when they save metadata JSON. They do not change the object the caller passed in.
- If removing the characters makes two keys the same, the request is rejected before the file is made public.
- The file's own bytes are not changed, including bytes whose value is 0. The ID is decided by the original bytes.

**`releaseSession(sessionId)`** is used when a session is deleted. It clears that session's ownership and references in one step. The file bytes and the references from other sessions are kept.

- Deleting a session removes the session's data first and calls it afterwards. If the deletion fails, the session is still there and can still read its own media.
- A failure of this call is only logged, and the deletion still succeeds. The claims it leaves behind show as "held" in the media library.

## HTTP content safety

**Upload: `POST /api/media`**

- Only images (`image/*`) are accepted.
- Before saving, the MIME type is normalized to lowercase, without parameters.
- SVG is rejected. The reason: an SVG opened under the application's own domain can run scripts.
- MIME types are compared without regard to case, and parameters are ignored. So `image/SVG+xml; charset=utf-8` is rejected too.

**Session check during upload**

An upload uses the same session record to authenticate, and it records the session's "incarnation" (a number that changes each time a session with the same ID is rebuilt). Before it records the owner and the references, the server checks again inside the session lock: the owner, the incarnation, whether the session is active, and whether it is being deleted.

The uploaded bytes are stored together with a temporary reference `media-pin:<uuid>`, so a concurrent cleanup cannot delete them before they are recorded inside the session lock. Whether the upload succeeds or is rejected, the request releases this temporary reference when it ends. The bytes of a rejected upload have no owner and are left to media cleanup.

| Situation                                                                       | Result                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------ |
| The owner changed during this time                                              | `401`                                            |
| The incarnation changed, or the session is no longer active or is being deleted | `409`                                            |
| Bytes that were stored before the request was rejected                          | No owner. They can be reclaimed by cleanup later |

**Read: `GET /api/media/:id`**

For a saved SVG file, the response includes `Content-Disposition: attachment` and `Content-Security-Policy: sandbox`.

- The same applies when historical data, or a MIME value written by a generator, has mixed case or parameters.
- Both the normal response and the `304` cache revalidation response include these two headers.

## Backends

| Backend         | Factory function                                | Where the bytes are stored                                    | `openReadStream()`                      |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| Memory          | `createMemoryMediaStore()`                      | Process memory                                                | Yes (gives the whole block at once)     |
| SQLite/local-fs | `createSqliteMediaStore(dbPath, { mediaRoot })` | Local files, at the path `{mediaRoot}/{ab}/{cd}/{sha256}.bin` | Yes (true streaming read)               |
| PostgreSQL      | `createPgMediaStore(databaseUrl)`               | The `body` column of `media_assets`, type `bytea`             | **No**, see "PG streaming caveat" below |

### Display cache in the browser

The web app has a separate "blob cache for rendering". It is not the same thing as a `MediaStore` backend.

- When the web app resolves media, it first checks that the session is allowed to read it, and only then looks in this cache.
- Cache records are validated. A record with the wrong format, or one that does not match, is ignored, and the validated network bytes are used instead.
- When writes happen at the same time, the first record is kept. This is done in one IndexedDB transaction. Writes and deletes count as done when their transaction completes.
- A cache error only produces diagnostic information. It never makes media that was downloaded successfully show as failed.

Connection rules:

- The display cache and the app's key-value store share one browser connection on each page.
- If opening fails or the handle has been closed, later operations can retry. When the database version changes, the old handle is released.
- If opening is blocked, it fails right away, and it gives up its final upgrade and connection. Until that native request ends, later calls reuse this failure directly and do not queue another blocked open.
- Cache diagnostics do not include raw exception details or signed URLs.
- Before an invalid record is cleared, the current record is checked again. A valid record that another tab has just written is not deleted.

### PG streaming caveat

`createPgMediaStore` intentionally does not implement `openReadStream`.

- A `bytea` column makes the driver read the whole file into memory before passing it to the caller. Wrapping it in a "stream" only buffers the whole file once more, which gives no benefit over calling `get()` directly.
- The routing layer in `apps/server/src/routes/api/media.ts` already checks `typeof store.openReadStream === 'function'`. When it is missing, the route automatically uses `get()` instead. Callers do not need to change.

> [!TIP]
> If you save media larger than a few MiB on PostgreSQL, consider putting the bytes in SQLite local-fs (`createSqliteMediaStore`). The rest of the kernel's state stays in PG.

## Media Wire Registries (image / speech / transcription / music)

This section covers the **generation** of media, not its storage. Generation goes through the pluggable wire registries in `@covel/ai-provider` (`packages/ai-provider/src/image/wire-registry.ts` and `packages/ai-provider/src/speech/wire-registry.ts`). They sit upstream of `MediaStore`. After a wire produces bytes, `ctx.images.generate()` / `ctx.speech.generate()` / `ctx.music.generate()` store them in `MediaStore`.

A wire implements the request and response format of one provider.

| Type                 | Built-in wires                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Image                | `openai-images` (the default, `DEFAULT_IMAGE_WIRE`), `dashscope-wan`                                                                  |
| Speech synthesis     | `openai-speech` (TTS, `POST /audio/speech`)                                                                                           |
| Speech transcription | `openai-transcription` (STT, `POST /audio/transcriptions`)                                                                            |
| Music                | No built-in wire (`packages/ai-provider/src/music/wire-registry.ts`). Providers have no shared request format, so plugins register it |

A wire whose provider answers with a "task" polls inside its `compose` step itself, and returns the audio at the end.

**Choosing a wire**

- Each model role chooses its own. In `llm.toml`, `imageWire` / `speechWire` / `transcriptionWire` / `musicWire` under `[covel.<slot>].providerRequestMetadata` hold the wire ID.
- If nothing is written, the built-in default is used. `musicWire` has no default, so leaving it out is a configuration error.
- An unknown ID throws an error during generation. It is never quietly swapped for another wire.

See [slots.md](./slots.md).

**Registering a wire**

- A plugin calls `covel.registerWires({ image?, speech?, transcription?, music?, text? })` in its `entry` module. The IDs get a prefix automatically and become `<pluginId>/<wireId>`. In a session a wire can be chosen only when its plugin is enabled there; a request that belongs to no session can choose only a builtin plugin's wire, and on the `self` tier a community plugin's as well. See [plugin-extensions.md § Models and new protocols](./plugin-extensions.md#models-and-new-protocols).
- Code bundled with the framework can also call `registerImageWire` / `registerSpeechWire` / `registerTranscriptionWire` directly. The ID is any string, not an enum value.

## Metadata Conventions & Querying

`put()`, `ctx.media.put()`, and `ctx.images.generate()` all accept a free-form `meta` object, which is saved along with the file. It holds two kinds of keys:

- **Business keys**: Defined by the plugin, describing what the picture "is". For example `kind` (`scene-background` / `character-sprite` / `illustration` / ...), `sceneId` or `characterId`, and `variant` (`day` / `night` / ...). The framework never reads them. They serve only the plugin's own conventions for querying them.
- **Framework keys**: `pluginId` and `promptHash`. They are written automatically by `ctx.images.generate()` (`packages/runtime/src/function-runtime/runtime-images-context.ts`) and `ctx.speech.generate()` (`runtime-speech-context.ts`). They are written **after** the caller's `metadata`, so a plugin cannot override them.

### `listByMetadata(sessionId, filter)`

Returns the files owned by `sessionId` whose `meta` contains every key-value pair in `filter`.

- The backend first reads only the files this session owns: SQLite and PostgreSQL query by `owner_session_id` in SQL, using the owner index. So the cost grows with this session's media, not with how much media other sessions have.
- Matching is an exact, shallow subset match. All three backends share one implementation: `filterAssetsByMetadata` in `packages/store/src/media-store/filter.ts`.
- If a value in `filter` is `undefined`, it matches both "the key is absent" and "the key was explicitly stored as `undefined`". (The comparison is `meta[k] === v`, and both sides read as `undefined`.)
- Only primitive values (string / number / boolean / `null`) make a meaningful comparison. Objects and arrays never match, because `===` compares references.

### `promptHash` idempotency

`promptHash` makes sure "the same request is not generated a second time".

**What it is calculated from**

| Call                    | What goes into the calculation                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.images.generate()` | The generation parameters (`prompt`, `negativePrompt`, `size`, `quality`, `n`, `background`), plus the resolved provider, model, protocol, endpoint, and the normalized wire metadata |
| `ctx.speech.generate()` | The same model identity, plus `presetId`, `text`, `voice`, `format`                                                                                                                   |
| `ctx.music.generate()`  | The same model identity, plus `presetId`, `prompt`, `lyrics`, `instrumental`, `durationSeconds`, `format`                                                                             |

- Not included: the API key, auth headers, business `metadata`, and `signal`.
- `ctx.images.generate()` resolves the current image binding before it checks the cache. If the same role is rebound to another model or wire, the cache is no longer used.
- Speech and music work the same way. A sentence or piece of music made by one model is not returned after the role is bound to another model. If the role is switched back to the first model, it can be returned again.

**How a hit happens**

1. Before calling the gateway, check `listByMetadata(sessionId, { promptHash, pluginId })`.
2. If there are already at least `n` matching files (for speech and music, 1), return those references with `cached: true`. This skips the call to the provider completely.

**Two things to be aware of**

- Two calls with the same prompt but different `metadata` hit the same cached file. The disk keeps the metadata from the **first** call. Each cached reference returned carries the business metadata of the current call.
- A partial hit (fewer than `n` files exist) **does not** count as a hit. In that case, the whole batch is generated again, instead of quietly returning fewer images.

**A batch of images is recorded together**

When `ctx.images.generate()` makes several images in one call, it stores every one of them first and then records them for the session together.

- If one of them fails to download or save (an expired URL, a type that is not allowed, a timeout, an abort), the whole call fails, and the images already stored are not recorded for the session either. They have no owner and are left to media cleanup.
- So a failed call never leaves part of a batch behind. The next identical request generates the whole batch again.

## Ownership

SQLite stores `media_assets.path` as a relative path (`ab/cd/<sha256>.bin`) beneath `mediaRoot`, which defaults to `media/` beside the database. Reads, streams, repairs and deletion resolve it against the current root. Copy or back up the database and this directory together; moving them does not require rewriting rows. A custom `mediaRoot` must be copied and configured separately. Development databases containing absolute media paths must be recreated; there is no migration or fallback.

**Writes to SQLite / local files**

- `put()` first writes the complete bytes to an exclusive temporary file in the target directory. It then renames the file atomically to the content path, and finally records the metadata.
- On retry, if an orphan file is found (a file that exists without metadata), it is replaced. The file's existence is never trusted by itself. A failed write deletes its own temporary file.
- Writing a file and reading a file in `get()` are both asynchronous, so one large image does not hold up other sessions. Only the metadata row goes through the database write queue. If the file was removed by a delete during this time, this step writes the file again.

**Ownership and references**

| Method              | What it does                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `recordOwnership()` | Sets the first owner of a file. First come, first served: a second call with a different `sessionId` does not overwrite it    |
| `addRef()`          | Gives another session read access. Used for forks and snapshots                                                               |
| `claimAssets()`     | Does `recordOwnership()` and then `addRef()` for each file of a batch, in one transaction: every claim is recorded or none is |
| `removeRef()`       | Removes one session's reference. It can be called repeatedly. It does not delete the bytes or change the owner                |
| `isReferencedBy()`  | Returns true for the owner session, or for a session that has a reference record                                              |

`ctx.media.put()` and `ctx.media.ingestUrl()` store the bytes together with a temporary reference `media-pin:<uuid>` (see [Creating a reference at the time of storing](#creating-a-reference-at-the-time-of-storing)), and release it once the owner and this session's reference are recorded. So from the moment the bytes are stored until they are recorded, a concurrent cleanup cannot delete them.

The claims are recorded with `claimAssets()`. The images stored by one `ctx.images.generate()` call, the files of one world-data import and one upload are each recorded in one transaction. When it fails part-way, none of the batch is recorded: ownership and references other sessions already hold stay as they are, and the session is not left with half a batch. All three backends behave the same, and a batch with U+0000 in an identifier is refused before anything is written.

If the runtime or guard that called them is aborted or times out during this time, the call is rejected, neither is recorded, and the temporary reference is still released. Bytes with no owner are left for media cleanup to reclaim.

<a id="checking-references-at-commit"></a>

**Checking references at commit**

Before a proposal commits, the kernel checks every `MediaRef` in its payload (for example the `ref` of `asset.generate`, the value of `plugin.data`, a picture in a `ui.render` spec). It uses the same check that runtime bindings, exports and job data share:

- If the file does not exist, if this session neither owns nor references it, or if the declared MIME type differs from the stored one, the proposal is rejected and handled as a commit failure (see [Tools reference](./tools.md#proposal-types)).
- A reference that passes is rewritten from the stored metadata: the MIME type and size come from the store, `url` is removed (it is signed again on read), and `meta` is kept.

So a foreign or dangling reference never reaches messages or plugin data, and does not surface only later as a 403 / 409 when the session is forked.

**`addRef()` is idempotent per `(sessionId, mediaId)`**

The UNIQUE constraint on `media_refs` does not include `plugin_id`. The plugin ID is recorded only as a note about the first source. This is safe. In SQL, `UNIQUE` treats every `NULL` as a different value. If the constraint included the nullable `plugin_id`, a caller passing `undefined` would quietly create countless duplicate records. The shape of this key matches Memory, which also uses `(sessionId, mediaId)` as the map key.

> [!WARNING]
> Only the current `(session_id, media_id)` constraint is supported. Development databases that use the old media reference structure must be rebuilt. The framework does not migrate them, and it does not delete the old records automatically.

**`delete()`**

`delete()` first removes every reference that points to the file, and then deletes the file. The SQL backends put both steps in one transaction. In particular, another SQLite process cannot insert a new reference between "clear the references" and "delete the file".

**Signed URL: `GET /api/sessions/:id/media-token`**

When a browser needs a fetchable URL, it obtains one through this endpoint. Neither `MediaStore` nor the plugin's `ctx.media` provides a URL resolver.

- On hosted deployments (`demo` / `commercial`), and when production uses MemoryStore (including the `self` browser-private mode), the session owner's credentials are required.
- As with other session routes, operator credentials can also authorize this request.
- The session must also own or reference the file it wants to read. Only then does the server issue a media URL.

**MIME rules for upload and read**

- `POST /api/media` accepts `image/*` and rejects `image/svg+xml`.
- When checking a MIME type, case, leading and trailing whitespace, and parameters are ignored. Accepted uploads are saved as a lowercase type without parameters.
- When reading, the metadata of historical files is normalized the same way first. SVG files always get `Content-Disposition: attachment` and `Content-Security-Policy: sandbox`, for both buffered and streamed responses.
- A saved MIME parameter still appears in the `Content-Type` of the read response.

### Creating a reference at the time of storing

`put(bytes, mime, meta?, initialRef?)` can create an initial reference in the same critical section or transaction in which the bytes become public. This also applies when the content already exists.

- It does not set an owner.
- This reference follows the usual first-come, first-served rule for `(sessionId, mediaId)`.
- Before `put` returns, cleanup can already see this reference.

### Temporary references during world data import

When preparing world data, the operation above is used to "pin" the bytes. The reference name is the unique `media-pin:<uuid>`. The colon is not one of the characters allowed in user session IDs, so it cannot clash with a real session. Uploads and runtime writes use the same temporary references.

- Each import attempt has its own temporary reference. Even if several concurrent attempts target the same session and the same content, they do not affect each other.
- At the end, ownership and a reference are first recorded for the real session, and then the temporary reference is released.
- When preparation, the semantic write, a duplicate session, or world admission fails, only this attempt's temporary reference is released. These failures do not force-delete shared content, and they do not release the claims of existing sessions. Bytes that no one claims later can be reclaimed by lifecycle cleanup.
- If a newly created session fails at media finalization, the create flow deletes that session inside the session lifecycle lock and releases its claims.
- After the commit, sync removes this session's explicit references to files it no longer needs. A file that still appears in the session's other index rows, messages, snapshots, runtime outputs, traces or turn results keeps its reference: the session and its forks can always read the pictures its history has shown. When the scan goes over its row limit (200,000), every reference is kept. Ownership and reclaiming the bytes are left to lifecycle cleanup.

When something goes wrong:

- If the semantic data of a sync was committed but finalization failed, the temporary reference is kept until the permanent claims can be restored.
- Session creation always releases it when finalization fails, even when the rollback (deleting the session) fails: the session data left behind still refers to those files, and the scan before cleanup protects them.
- Releasing a temporary reference is best effort. A failure is only logged, and it does not change the result of the import.
- A process crash or a failed release can leave a temporary reference behind. Until it expires, cleanup keeps its bytes.

> [!NOTE]
> An abandoned temporary reference expires 24 hours after it was created. Only `POST /api/media/cleanup` releases expired references: a dry run lists them in `expiredRefs`, and a real run removes them. No timer does this, and neither does a delete from the media library.
>
> An import, upload or runtime write holds its temporary reference for one request or call only, far less than 24 hours, so cleanup does not take a reference from a write that is still running. The limit is fixed. A request or an environment variable cannot change it.

## Pictures sent to the story model

Apart from showing pictures to the player, the kernel reads picture bytes for only one purpose. When the story agent's model accepts image input, it receives the session's latest pictures as inline base64 images (see [Prompt structure reference](./prompt-structure.md#images-that-have-been-shown)). This read has the same limits as a player read:

- Before calling the model, the agent loop holds only the `MediaRef`. It calls `lookup()` to get the saved MIME type and size, then calls `isReferencedBy(id, sessionId)` to confirm the session may read the file, and only then calls `get()`. A file that the session neither owns nor references is never sent.
- Only `image/png`, `image/jpeg`, `image/webp`, and `image/gif` are sent, with at most 3,750,000 raw bytes for each picture. A picture over the limit is skipped. The kernel never resizes pictures.
- The provider layer receives bytes, never a location. Media URLs, signed tokens, file paths, and `MediaRef.url` never go into the prompt, and the provider layer does not download anything. If a read fails, a warning is logged, and the call continues without that picture.
- The trace stores the length of the inline data, not the data itself.

## Lifecycle Cleanup

**Who owns the SQLite connection**

The SQLite media factory holds its own reference to the shared connection until construction succeeds. If initialization fails, it releases only that one reference, leaves the other holders alone, and rethrows the original error. After success, the returned store's `close()` is responsible for releasing it. The connection closes only when the last holder releases it.

**Cleanup endpoint: `POST /api/media/cleanup`**

The framework provides this endpoint for manual cleanup and for hooking into scheduled jobs.

1. The route uses the shared `collectMediaRefIds()` to scan: the existing sessions, messages, plugin data, runtime outputs, trace events, snapshots, turn results, and `MediaStore.listAssets()` and `MediaStore.listRefs()`.
2. It passes the resulting "protected ID set" to `MediaStore.cleanup()`.

Conditions for using this endpoint:

| Condition                                                         | What happens if it is not met                      |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| The deployment is not `commercial`                                | `503 unavailable`                                  |
| A `demo` deployment carries the configured operator bearer token  | Rejected before the switch and the policy are read |
| `COVEL_MEDIA_CLEANUP_ENABLED=true` is set                         | `403`. The endpoint is off by default              |
| With `dryRun: false`, the request header `X-Confirm-Cleanup: yes` | `400`                                              |

A personal host needs no additional token for this route after the host and local-access checks. Production `self` with MemoryStore is browser-private and still requires an operator token; `self` alone does not grant access. The [host profile](../internals/security.md#host-profile) defines these rules centrally. Each session has a limit on the number of rows it can scan (`scanLimit`, default 1,000). If a session goes over, the endpoint refuses to run. It does not quietly scan only part of the data.

**`protectedIds` is a plan, not the final decision**

- The cleanup plan also includes every current ownership and reference claim, including temporary references from imports that have not expired. So a dry run reports pinned files as protected.
- Each backend checks the file's current ownership and references again inside the same critical section or transaction in which it deletes. PG uses an advisory transaction lock plus `NOT EXISTS`. SQLite uses `BEGIN IMMEDIATE`. Memory checks the map synchronously.
- So a reference or ownership that is created after the route's scan still protects the file. The returned cleanup counts and IDs reflect what was actually deleted, not a copy of the outdated plan.

**Extra rules for SQLite**

- SQLite holds the `BEGIN IMMEDIATE` lock until the content file has been deleted. This way, a concurrent `put()` with the same content cannot recreate the bytes before the old delete finishes.
- If deleting the file (unlink) fails, the removal of the metadata and references is rolled back together.
- The actual `delete()` and a non-dry-run `cleanup()` must run outside any existing SQL transaction. If a transaction is already open on the shared connection, they refuse to run before they change any metadata or references. The caller must wait until its own DataStore transaction has ended before calling them. The reason: an outer SQL rollback cannot undo a filesystem unlink.
- This restriction does not apply to `put()` or to a dry run of cleanup. Those can use the shared connection inside a DataStore transaction.

**Fields of the cleanup policy**

| Field             | Meaning                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `dryRun`          | Default `true`: only returns the deletion plan. The bytes are kept as they are                               |
| `maxAgeMs`        | Deletes unprotected files created at or before `now - maxAgeMs`                                              |
| `maxBytes`        | Deletes unprotected files starting from the oldest, until the total stored bytes are no more than this limit |
| `keepRecentBytes` | Keeps this many bytes of the newest unprotected files. Older unprotected files are chosen for deletion       |

- An empty policy returns a list-style dry-run result, with zero selected for deletion.
- `expireRefs: { sessionIdPrefix, maxAgeMs }` exists only in the store interface. It makes cleanup also release abandoned references: those whose session ID starts with `sessionIdPrefix` and that were created at or before `now - maxAgeMs`. The prefix must contain a colon, or the call is rejected: no session ID contains a colon, so a real session's reference never matches. The cleanup endpoint always passes `media-pin:` and 24 hours. The released references are listed in `expiredRefs` of the result. Such a reference no longer protects its file, but whether the file is deleted still depends on the other fields and the other claims.
- `onlyIds` exists only in the store interface. The cleanup endpoint does not accept it. It limits the policy to the listed files: other files are kept no matter what the other fields say. The media library deletes with `{ maxBytes: 0, onlyIds }`, so one delete can touch only the files it names. Each file still has to pass the ownership and reference checks above.

The desktop app and the web app read media using the same authoritative store metadata. An entry in the browser cache is checked against the `MediaRef` before it is used for display.

## Media library

The player views and deletes saved media in **Settings → Stored media**. It is served by `GET /api/media/library` and `POST /api/media/library/delete` (see [api.md](./api.md)). Nothing is deleted without confirming there. `POST /api/media/cleanup` is still an operator tool.

**What counts as "in use".** One scan (`apps/server/src/routes/api/media-reference-scan.ts`, shared with the cleanup endpoint) works out, for each media ID, which sessions are using it right now. A session counts as using a file when any of the following is true:

- It is the owner of the file (`recordOwnership`).
- It holds an explicit reference (`addRef`, which is a row in `media_refs`).
- The ID appears as a `MediaRef` in any row of that session's `messages`, `plugin_data`, `runtime_outputs`, `trace_events`, `snapshots`, or `turn_results`.

This gives four states:

| State                 | Meaning                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In use                | At least one current session uses it                                                                                                                     |
| **Unused** (unused)   | A complete scan found no such session, and nothing else claims it                                                                                        |
| **Held** (held)       | Its owner or reference is not a current session: a temporary reference `media-pin:<uuid>` from a write in progress, or a claim that outlives its session |
| **Unknown** (unknown) | The scan was incomplete, and no known user was found for this file                                                                                       |

When a scan is incomplete: a session has more rows than the limit (for the media library, it is 200,000, and the `scanLimit` parameter can change it). In that case no file counts as "unused", and a request to delete unused media is refused with `409 scan_incomplete`. A session that cannot be read is never treated as a "session with no references".

**Media in worlds.** Files in a world package (`worlds/<id>/media`, covers, portraits) are not in MediaStore. The media library neither lists nor deletes them.

- World data with `to: media` copies its bytes into MediaStore when a session is created.
- Every session of that world claims the same content-addressed file. The first session is both owner and holder of a reference. Each later session holds only a reference.
- Deleting a session releases only that session's claims. So the file keeps counting as in use until the last session in that world that holds it is deleted.
- A world with no sessions does not need this copy. The next session re-imports the file from the world package.

**Cost.**

- One list request scans every row of every session. Paging, filtering, and counting within the next 30 seconds are answered from that scan's results. `refresh=1` scans again.
- Every delete request scans again, and it discards the cached results.
- The list does not include bytes. Each item has a signed URL that is valid for one hour. Its token has the scope `media-library:`, not a session. (A colon is not one of the characters allowed in session IDs.) `GET /api/media/:id` accepts this scope only in deployments where the media library is available.
- The server has no thumbnails, so the image URL returns the original image. The page shows 48 items at a time. Images load lazily, and audio and video load only when the player opens them.

**Deleting.**

- Unused media is deleted with `MediaStore.cleanup()` using `onlyIds`. So each backend checks the file's ownership and references again inside the critical section where it deletes. A file that a session claims after the scan is kept, and it is reported as "skipped".
- A file that is in use, held, or unknown can only be deleted with a request that has `force` and names exactly one ID. In that case, `delete()` removes it together with every reference that points to it.
- Sessions that used the file keep their own records. Where an image or sound used to be, the interface shows a "media unavailable" placeholder. When a plugin requests the same generation again, it gets a new file.
- Forking from these sessions still succeeds, and the missing files show the same placeholder in the child (see [the fork in api.md](./api.md#post-apisessionsidfork)).

**Access.** The media library exists only where everything the server saves belongs to the same player: `DEPLOYMENT_TIER=self` and the desktop app. In `demo` and `commercial` deployments, and in browser-private mode (where the production server uses MemoryStore), MediaStore holds media with several owners, and there is no index by owner. So both routes return `503 unavailable`, with or without an operator token.

## Tests

The shared contract tests are in `packages/store/src/contract/media-store-contract.ts`. Current coverage: Memory, SQLite/local-fs, and PostgreSQL when `DATABASE_URL` points to a database that can be reached (`packages/store/tests/media-store.test.ts`).
