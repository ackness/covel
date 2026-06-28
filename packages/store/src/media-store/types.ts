import type { MediaAssetRecord, MediaRefRecord } from "@covel/shared";
import type { StoreBackend } from "../types.js";

export type MediaStoreBackend =
  | "mirror"
  | "memory"
  | "sqlite"
  | "pg"
  | "s3"
  | "idb"
  | "none";

export interface MediaStoreConfig {
  readonly backend?: MediaStoreBackend;
  readonly storeBackend?: StoreBackend;
  readonly sqlitePath?: string;
  readonly databaseUrl?: string;
  readonly mediaRoot?: string;
  readonly idbDbName?: string;
  readonly s3Bucket?: string;
  readonly s3Region?: string;
  readonly s3Endpoint?: string;
  readonly s3KeyPrefix?: string;
  readonly s3PublicBaseUrl?: string;
}

// Re-export the shared MediaStore wire-shape interfaces so existing
// `import { MediaStore, ... } from "@covel/store"` call sites keep
// working without churn. The canonical definitions now live in
// `@covel/shared/src/types/media.ts` so browser code can reference
// the contract without dragging Node-only modules into the bundle.
export type {
  MediaAssetLookup,
  MediaAssetRecord,
  MediaCleanupResult,
  MediaLifecyclePolicy,
  MediaRefRecord,
  MediaStore,
} from "@covel/shared";

export interface SqliteMediaStoreOptions {
  readonly mediaRoot?: string;
}

export interface PgMediaStoreOptions {
  readonly freshSchema?: boolean;
}

export interface S3CompatibleObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface S3CompatibleObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly mime: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface S3CompatibleMediaClient {
  putObject(input: S3CompatibleObject): Promise<void>;
  getObject(key: string): Promise<S3CompatibleObject | null>;
  headObject(key: string): Promise<S3CompatibleObjectInfo | null>;
  deleteObject(key: string): Promise<void>;
  createSignedGetUrl?(key: string): Promise<string>;
}

export interface S3MediaStoreOptions {
  readonly bucket?: string;
  readonly keyPrefix?: string;
  readonly publicBaseUrl?: string;
  /**
   * Durable metadata adapter. When supplied, owner / refs / asset metadata
   * are delegated to the adapter (typically SQLite or PostgreSQL) instead of
   * the default in-process Maps. Required for production: without it, owner
   * and ref state evaporate on every restart, and `lookup()` always reports
   * `ownerSessionId: null` post-restart — meaning every strict-route asset
   * becomes inaccessible.
   *
   * See `createSqliteS3MetadataAdapter` for the canonical implementation.
   */
  readonly metadataAdapter?: S3MediaMetadataAdapter;
}

/**
 * Persistence interface for S3-backed `MediaStore` metadata. The S3 client
 * stores opaque bytes; everything else (owner, refs, mime, size, meta,
 * createdAt) flows through this adapter so it can survive restarts and span
 * multiple server instances. Implementations live alongside the SQL backends
 * (`createSqliteS3MetadataAdapter` for single-node, `createPgS3MetadataAdapter`
 * for multi-node).
 */
export interface S3MediaMetadataAdapter {
  /** Idempotent insert of an asset row. First writer wins for mime/size/meta. */
  upsertAsset(record: MediaAssetRecord): Promise<void>;
  /** Look up combined asset + owner metadata; null if unknown. */
  getAsset(id: string): Promise<MediaAssetRecord | null>;
  /** First-writer-wins ownership. Subsequent calls with a different sessionId are no-ops. */
  recordOwnership(
    id: string,
    ownerSessionId: string,
    ownerPluginId?: string,
  ): Promise<void>;
  /** Idempotent on (sessionId, mediaId); plugin_id is first-writer metadata only. */
  addRef(id: string, sessionId: string, pluginId?: string): Promise<void>;
  /** Remove only one session's explicit ref; bytes and owner metadata remain. */
  removeRef(id: string, sessionId: string): Promise<void>;
  isReferencedBy(id: string, sessionId: string): Promise<boolean>;
  listAssets(): Promise<readonly MediaAssetRecord[]>;
  listRefs(): Promise<readonly MediaRefRecord[]>;
  /** Remove the asset row plus all its refs. Called from MediaStore.delete(). */
  deleteAsset(id: string): Promise<void>;
}
