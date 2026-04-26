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
  recordOwnership(id: string, ownerSessionId: string, ownerPluginId?: string): Promise<void>;
  addRef(id: string, sessionId: string, pluginId?: string): Promise<void>;
  isReferencedBy(id: string, sessionId: string): Promise<boolean>;
  listAssets(): Promise<readonly MediaAssetRecord[]>;
  listRefs(): Promise<readonly MediaRefRecord[]>;
  cleanup(protectedIds: ReadonlySet<string>, policy?: MediaLifecyclePolicy): Promise<MediaCleanupResult>;
  openReadStream?(ref: MediaRef): Promise<ReadableStream<Uint8Array>>;
}
```

`put()` computes a SHA-256 id from the bytes and deduplicates repeated content. The first stored metadata wins for duplicate content.

## Backends

| Backend | Factory | Byte storage | `openReadStream()` |
|---|---|---|---|
| Memory | `createMemoryMediaStore()` | Process memory | yes (single chunk) |
| SQLite/local-fs | `createSqliteMediaStore(dbPath, { mediaRoot })` | Local files under `{mediaRoot}/{ab}/{cd}/{sha256}.bin` | yes (true streaming) |
| PostgreSQL | `createPgMediaStore(databaseUrl)` | `media_assets.body` as `bytea` | **no** — see "PG streaming" |
| S3/R2-compatible | `createS3MediaStore(client, options)` | External object storage via `S3CompatibleMediaClient` | yes (eager `get()` wrap) |
| IndexedDB (web) | `createIndexedDbMediaStore({ dbName })` | Browser IDB Blob store | yes (Blob.stream()) |

The S3/R2 adapter accepts a small object-client interface. Production deployments can wrap AWS SDK S3, Cloudflare R2, MinIO, or any compatible object store behind that interface.

### PG streaming caveat

`createPgMediaStore` intentionally does **not** implement `openReadStream`. The `bytea` column type forces the entire blob into memory before the driver can hand it back, so a "streaming" wrapper would just buffer the whole asset and add no value over the eager `get()` path. The route layer in `apps/server/src/routes/api/media.ts` already gates on `typeof store.openReadStream === 'function'` and falls back to `get()` automatically — no caller change is required.

If you store media larger than a few MiB on PostgreSQL, consider one of:

- Move bytes to SQLite local-fs (`createSqliteMediaStore`) and keep PG for the rest of the kernel state.
- Use S3/R2 (`createS3MediaStore`) with a durable metadata adapter — see "S3 metadata adapter" below.

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

## S3 metadata adapter

`createS3MediaStore(client)` only persists bytes to the bucket. Owner / refs / mime / size / `createdAt` go through an `S3MediaMetadataAdapter` so they survive process restarts and span multiple server instances.

| Wiring | When to use |
|---|---|
| `createS3MediaStore(client)` (no adapter) | Dev only. Logs a warning at construction. Owner / refs vanish on restart and `lookup()` always reports `ownerSessionId: null` post-restart, which makes every strict-route asset inaccessible. |
| `createS3MediaStore(client, { metadataAdapter: createSqliteS3MetadataAdapter(dbPath) })` | Single-node production. Reuses the standard `media_assets` / `media_refs` schema; the same SQLite database can host metadata for both local-fs media and S3-backed media. |
| `createS3MediaStore(client, { metadataAdapter: <custom PG adapter> })` | Multi-node production. A PG-backed adapter is the natural next step (TODO — open follow-up); implement the `S3MediaMetadataAdapter` interface against the existing `media_assets` / `media_refs` PG tables. |

```ts
import {
  createS3MediaStore,
  createSqliteS3MetadataAdapter,
} from '@covel/store';

const mediaStore = createS3MediaStore(s3Client, {
  bucket: 'covel-media',
  keyPrefix: 'prod',
  metadataAdapter: createSqliteS3MetadataAdapter('/var/lib/covel/media-meta.db'),
});
```

## Lifecycle Cleanup

The framework exposes `POST /api/media/cleanup` for manual cleanup and scheduler integration. The route scans live sessions, messages, plugin data, runtime outputs, trace events, snapshots, turn results, `MediaStore.listAssets()`, and `MediaStore.listRefs()` with the shared `collectMediaRefIds()` scanner, then passes the protected id set into `MediaStore.cleanup()`.

Cleanup policy fields:

| Field | Meaning |
|---|---|
| `dryRun` | Defaults to `true`; returns the deletion plan while keeping bytes in place |
| `maxAgeMs` | Deletes unprotected assets created at or before `now - maxAgeMs` |
| `maxBytes` | Deletes oldest unprotected assets until total stored bytes fit the cap |
| `keepRecentBytes` | Keeps the newest unprotected byte budget and selects older unprotected assets |

An empty policy returns an inventory-style dry run with zero selected deletions. Tauri desktop uses the same authoritative store metadata; the native path remains the byte transport layer.

## Tests

The shared contract lives in `packages/store/src/contract/media-store-contract.ts`. Current coverage runs against Memory, SQLite/local-fs, S3-compatible fake storage, and PostgreSQL when `DATABASE_URL` points at a reachable database.
