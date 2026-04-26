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

| Backend | Factory | Byte storage |
|---|---|---|
| Memory | `createMemoryMediaStore()` | Process memory |
| SQLite/local-fs | `createSqliteMediaStore(dbPath, { mediaRoot })` | Local files under `{mediaRoot}/{ab}/{cd}/{sha256}.bin` |
| PostgreSQL | `createPgMediaStore(databaseUrl)` | `media_assets.body` as `bytea` |
| S3/R2-compatible | `createS3MediaStore(client, options)` | External object storage via `S3CompatibleMediaClient` |

The S3/R2 adapter accepts a small object-client interface. Production deployments can wrap AWS SDK S3, Cloudflare R2, MinIO, or any compatible object store behind that interface.

## Ownership

`recordOwnership()` sets the first owner for an asset. `addRef()` grants another session read access for fork and snapshot flows. `isReferencedBy()` returns true for the owner session and for sessions with an explicit reference row.

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
