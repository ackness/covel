/** Browser-safe checkpoint contract. No server backend modules are exported. */
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
} from "./browser-sync.js";

export type {
  BrowserCheckpoint,
  BrowserCheckpointState,
  BrowserCheckpointSchemaVersion,
  PersistenceProfile,
  SessionCommit,
} from "./browser-sync.js";

export type { MessageRecord } from "../records/state-records.js";
export type { SessionRecord } from "../records/session-records.js";
export type { WorldRecord } from "../records/world-records.js";
