export { createStore, createStoreFromEnv, resolveBackendFromEnv } from './factory.js';
export { createMemoryStore } from './memory/memory-store.js';
export { createSqliteStore } from './sqlite/sqlite-store.js';
export { createPgStore } from './postgres/pg-store.js';
export { createMemoryMediaStore, createSqliteMediaStore } from './media-store.js';
export { supportsVector } from './vector-store.js';
export type { MediaAssetLookup, MediaStore, SqliteMediaStoreOptions } from './media-store.js';
export type {
  VectorStoreCapability,
  VectorModelOps,
  EmbeddingModelIdentity,
  VectorTarget,
  UpsertVectorInput,
  SearchVectorsInput,
  VectorSearchResult,
  DeleteVectorsInput,
} from './vector-store.js';
export type {
  DataStore,
  StoreBackend,
  StoreConfig,
  WorldRecord,
  SessionRecord,
  TurnResultRecord,
  RuntimeResultRecord,
  ToolCallRecordRow,
  StateSchemaRecord,
  StateEntryRecord,
  StateChangeRecord,
  EventRecord,
  ApprovalRecord,
  MessageRecord,
  CharacterRecord,
  PluginDataRecord,
  PluginConfigRecord,
  TraceEventRecord,
  RuntimeOutputRecord,
  InteractionRecordRow,
  RuntimeOutputFilters,
  InteractionRecordFilters,
  TurnMessageRecord,
  PlayerInputRecord,
  WorkingMemoryRecord,
  LorebookEntryRecord,
  SessionSummaryRecord,
  PaginationOpts,
  SuspensionRecord,
  SnapshotRecord,
  SnapshotPayload,
  SnapshotKind,
} from './types.js';
