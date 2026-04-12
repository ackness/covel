export { createStore, createStoreFromEnv } from './factory.js';
export { createMemoryStore } from './memory/memory-store.js';
export { createSqliteStore } from './sqlite/sqlite-store.js';
export { createPgStore } from './postgres/pg-store.js';
export { supportsVector } from './vector-store.js';
export type {
  VectorStoreCapability,
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
  TurnMessageRecord,
  PlayerInputRecord,
  WorkingMemoryRecord,
  SessionSummaryRecord,
  PaginationOpts,
} from './types.js';
