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
  isReferencedBy(id: string, sessionId: string): Promise<boolean>;
  listAssets(): Promise<readonly MediaAssetRecord[]>;
  listRefs(): Promise<readonly MediaRefRecord[]>;
  cleanup(
    protectedIds: ReadonlySet<string>,
    policy?: MediaLifecyclePolicy,
  ): Promise<MediaCleanupResult>;
  openReadStream?(ref: MediaRef): Promise<ReadableStream<Uint8Array>>;
}
```

`put()` computes a SHA-256 id from the bytes and deduplicates repeated content. The first stored metadata wins for duplicate content.

## Backends

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

## Ownership

`recordOwnership()` sets the first owner for an asset. `addRef()` grants another session read access for fork and snapshot flows. `isReferencedBy()` returns true for the owner session and for sessions with an explicit reference row.

`addRef()` is **idempotent on `(sessionId, mediaId)`** — the `media_refs` UNIQUE constraint ignores `plugin_id` (which is recorded as first-source metadata only). This is the safe behaviour because SQL `UNIQUE` treats every `NULL` as distinct, so a constraint that includes a nullable `plugin_id` would silently allow unbounded duplicate rows when callers passed `undefined`. The new key shape matches Memory and IndexedDB, which use `(sessionId, mediaId)` as their map key.

> **Existing databases.** Fresh installs get the new constraint immediately. Existing PG/SQLite databases keep any pre-existing UNIQUE on `(session_id, media_id, plugin_id)` — that older index is strictly looser than the new one, so the stricter constraint wins and addRef stays safe. **Sites with legacy duplicate rows** (same `session_id` + `media_id` with different `plugin_id`) MUST run a one-off migration before the new index can be created. Templates:
>
> ```sql
> -- PostgreSQL
> DELETE FROM media_refs a USING media_refs b
>   WHERE a.ctid > b.ctid AND a.session_id = b.session_id AND a.media_id = b.media_id;
> CREATE UNIQUE INDEX pg_media_refs_unique_session_media_idx
>   ON media_refs(session_id, media_id);
>
> -- SQLite (apply through pnpm db:migrate after deduplicating)
> DELETE FROM media_refs
>  WHERE rowid NOT IN (
>    SELECT MIN(rowid) FROM media_refs GROUP BY session_id, media_id
>  );
> ```

## Lifecycle Cleanup

The framework exposes `POST /api/media/cleanup` for manual cleanup and scheduler integration. The route scans live sessions, messages, plugin data, runtime outputs, trace events, snapshots, turn results, `MediaStore.listAssets()`, and `MediaStore.listRefs()` with the shared `collectMediaRefIds()` scanner, then passes the protected id set into `MediaStore.cleanup()`.

Cleanup policy fields:

| Field             | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `dryRun`          | Defaults to `true`; returns the deletion plan while keeping bytes in place    |
| `maxAgeMs`        | Deletes unprotected assets created at or before `now - maxAgeMs`              |
| `maxBytes`        | Deletes oldest unprotected assets until total stored bytes fit the cap        |
| `keepRecentBytes` | Keeps the newest unprotected byte budget and selects older unprotected assets |

An empty policy returns an inventory-style dry run with zero selected deletions. Desktop and web media reads use the same authoritative store metadata, with browser cache entries validated against the `MediaRef` before serving.

## Tests

The shared contract lives in `packages/store/src/contract/media-store-contract.ts`. Current coverage runs against Memory, SQLite/local-fs, and PostgreSQL when `DATABASE_URL` points at a reachable database.
