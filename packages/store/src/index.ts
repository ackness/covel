export {
  createStore,
  createStoreFromEnv,
  resolveBackendFromEnv,
} from "./factory.js";
export { BROWSER_IDB_DATABASE_NAME, STORAGE_MIGRATIONS } from "./migrations.js";
export { describeStorageCapabilities } from "./storage-capabilities.js";
export {
  createMediaStore,
  createMediaStoreFromEnv,
} from "./media-store/factory.js";
export { supportsVector } from "./vector-store.js";
export { rebindSnapshotPayloadSession } from "./records/snapshot-session-scope.js";
export {
  SessionAlreadyExistsError,
  SessionRecordScopeConflictError,
} from "./errors.js";
export {
  BROWSER_CHECKPOINT_SCHEMA_VERSION,
  PERSISTENCE_PROFILES,
  ActionIdConflictError,
  BrowserSyncValidationError,
  RevisionConflictError,
  applySessionCommit,
  assertBrowserCheckpoint,
  assertPersistenceProfile,
  assertSessionCommit,
  isBrowserCheckpoint,
  isPersistenceProfile,
  isSessionCommit,
  validateBrowserCheckpoint,
  validateSessionCommit,
} from "./browser-sync/browser-sync.js";
export type {
  BrowserCheckpoint,
  BrowserCheckpointState,
  BrowserCheckpointSchemaVersion,
  PersistenceProfile,
  SessionCommit,
} from "./browser-sync/browser-sync.js";
export {
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
} from "./browser-sync/session-checkpoint.js";
export type {
  ExportSessionCheckpointOptions,
  ReplaceSessionCheckpointOptions,
} from "./browser-sync/session-checkpoint.js";
export type {
  MediaAssetLookup,
  MediaAssetRecord,
  MediaCleanupResult,
  MediaLifecyclePolicy,
  MediaRefRecord,
  MediaStore,
  MediaStoreBackend,
  MediaStoreConfig,
  PgMediaStoreOptions,
  SqliteMediaStoreOptions,
} from "./media-store.js";
export type { IndexedDbMediaStoreOptions } from "./indexeddb/idb-media-store.js";
export type {
  StorageMigrationDomain,
  StorageMigrationStatus,
  StorageMigrationSummary,
} from "./migrations.js";
export type {
  DescribeStorageCapabilitiesOptions,
  FrontendStorageMode,
  StorageCapabilityDescriptor,
} from "./storage-capabilities.js";
export type { VectorBackend, VectorStore } from "./vector-store.js";
export type {
  VectorStoreCapability,
  VectorModelOps,
  EmbeddingModelIdentity,
  VectorTarget,
  UpsertVectorInput,
  SearchVectorsInput,
  VectorSearchResult,
  DeleteVectorsInput,
  VectorIndexProgressScope,
  CommitVectorIndexBatchInput,
} from "./vector-store.js";
export type {
  DataStore,
  StoreTransaction,
  StoreBackend,
  StoreConfig,
  WorldRecord,
  SessionRecord,
  TurnResultRecord,
  ToolCallRecordRow,
  StateSchemaRecord,
  StateEntryRecord,
  StateChangeRecord,
  EventRecord,
  MessageRecord,
  CharacterRecord,
  PluginDataRecord,
  PluginDataBatchCasEntry,
  TraceEventRecord,
  RuntimeOutputRecord,
  InteractionRecordRow,
  RuntimeOutputFilters,
  InteractionRecordFilters,
  TurnMessageRecord,
  TurnMessageStats,
  PlayerInputRecord,
  WorldDataImportLedgerRecord,
  LorebookEntryRecord,
  SessionSummaryRecord,
  PaginationOpts,
  SuspensionRecord,
  SnapshotRecord,
  SnapshotPayload,
  SnapshotSessionState,
  SnapshotKind,
} from "./types.js";
