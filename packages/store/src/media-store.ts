export type {
  MediaAssetLookup,
  MediaAssetRecord,
  MediaCleanupResult,
  MediaLifecyclePolicy,
  MediaRefRecord,
  MediaStore,
} from "@covel/shared";
export {
  createMediaStore,
  createMediaStoreFromEnv,
} from "./media-store/factory.js";
export { createMemoryMediaStore } from "./media-store/memory.js";
export {
  createPgMediaStore,
  createPgMediaStoreFromClient,
} from "./media-store/pg.js";
export { createS3MediaStore } from "./media-store/s3.js";
export { createSqliteMediaStore } from "./media-store/sqlite.js";
export type {
  MediaStoreBackend,
  MediaStoreConfig,
  PgMediaStoreOptions,
  S3CompatibleMediaClient,
  S3CompatibleObject,
  S3CompatibleObjectInfo,
  S3MediaMetadataAdapter,
  S3MediaStoreOptions,
  SqliteMediaStoreOptions,
} from "./media-store/types.js";
