// IndexedDB requires a monotonically increasing integer version for schema
// upgrades. Keep all browser-local object stores on this single version.
export const BROWSER_IDB_SCHEMA_VERSION = 11;
export const BROWSER_IDB_DATABASE_NAME = "covel-browser";
export const APP_KV_STORE_STATE_SNAPSHOTS = "stateSnapshots";
export const APP_KV_STORE_WORLD_OVERLAYS = "worldOverlays";
export const APP_KV_STORE_STATE_PATCHES = "statePatches";
export const APP_KV_STORE_SUBMITTED_BLOCKS = "submittedBlocks";
export const APP_KV_STORE_EXECUTION_STEPS = "executionSteps";
export const MEDIA_CACHE_STORE_BLOBS = "media_cache_blobs";

interface BrowserSchemaStore {
  createIndex(
    name: string,
    keyPath: string | readonly string[],
    options?: IDBIndexParameters,
  ): unknown;
}

interface BrowserSchemaDatabase {
  readonly objectStoreNames: DOMStringList;
  createObjectStore(
    name: string,
    options?: IDBObjectStoreParameters,
  ): BrowserSchemaStore;
  deleteObjectStore(name: string): void;
}

function createObjectStore(
  db: BrowserSchemaDatabase,
  name: string,
  options?: IDBObjectStoreParameters,
): BrowserSchemaStore {
  return db.createObjectStore(name, options);
}

function ensureStore(
  db: BrowserSchemaDatabase,
  name: string,
  options?: IDBObjectStoreParameters,
): BrowserSchemaStore | null {
  if (db.objectStoreNames.contains(name)) return null;
  return createObjectStore(db, name, options);
}

export function upgradeBrowserIdbSchema(
  db: BrowserSchemaDatabase,
  oldVersion: number,
): void {
  if (oldVersion < 8 && db.objectStoreNames.contains("sessions")) {
    db.deleteObjectStore("sessions");
  }

  ensureStore(db, "sessions", { keyPath: "id" });

  const turnResults = ensureStore(db, "turnResults", { keyPath: "id" });
  turnResults?.createIndex("sessionId", "sessionId");

  const runtimeResults = ensureStore(db, "runtimeResults", { keyPath: "id" });
  runtimeResults?.createIndex("sessionId_turnId", ["sessionId", "turnId"]);

  const toolCalls = ensureStore(db, "toolCalls", { keyPath: "id" });
  toolCalls?.createIndex("sessionId", "sessionId");
  toolCalls?.createIndex("sessionId_turnId", ["sessionId", "turnId"]);

  const stateSchemas = ensureStore(db, "stateSchemas", { keyPath: "id" });
  stateSchemas?.createIndex("sessionId", "sessionId");

  const stateEntries = ensureStore(db, "stateEntries", { keyPath: "id" });
  stateEntries?.createIndex("sessionId", "sessionId");
  stateEntries?.createIndex("lookup", ["sessionId", "tableName", "fieldName"]);

  const stateChanges = ensureStore(db, "stateChanges", { keyPath: "id" });
  stateChanges?.createIndex("sessionId", "sessionId");

  const events = ensureStore(db, "events", { keyPath: "id" });
  events?.createIndex("sessionId", "sessionId");

  const approvals = ensureStore(db, "approvals", { keyPath: "id" });
  approvals?.createIndex("sessionId", "sessionId");

  const messages = ensureStore(db, "messages", { keyPath: "id" });
  messages?.createIndex("sessionId", "sessionId");

  const characters = ensureStore(db, "characters", { keyPath: "id" });
  characters?.createIndex("sessionId", "sessionId");

  ensureStore(db, "worlds", { keyPath: "id" });

  const traceEvents = ensureStore(db, "traceEvents", { keyPath: "id" });
  traceEvents?.createIndex("sessionId", "sessionId");

  const turnMessages = ensureStore(db, "turnMessages", { keyPath: "id" });
  turnMessages?.createIndex("sessionId", "sessionId");

  const playerInputs = ensureStore(db, "playerInputs", { keyPath: "id" });
  playerInputs?.createIndex("sessionId", "sessionId");
  playerInputs?.createIndex("lookup", ["sessionId", "formId"]);

  const pluginData = ensureStore(db, "plugin_data", { keyPath: "id" });
  pluginData?.createIndex("sessionId_pluginId", ["sessionId", "pluginId"]);
  pluginData?.createIndex("lookup", [
    "sessionId",
    "pluginId",
    "namespace",
    "key",
  ]);

  const workingMemory = ensureStore(db, "working_memory", { keyPath: "id" });
  workingMemory?.createIndex("sessionId", "sessionId");
  workingMemory?.createIndex("scopeKeyLookup", ["sessionId", "scope", "key"]);

  const summaries = ensureStore(db, "sessionSummaries", { keyPath: "id" });
  summaries?.createIndex("sessionId", "sessionId");

  const suspensions = ensureStore(db, "suspensions", { keyPath: "id" });
  suspensions?.createIndex("sessionId", "sessionId");

  const snapshots = ensureStore(db, "state_snapshots", { keyPath: "id" });
  snapshots?.createIndex("sessionId", "sessionId");

  const lorebookEntries = ensureStore(db, "lorebook_entries", {
    keyPath: "id",
  });
  lorebookEntries?.createIndex("sessionId", "sessionId");

  const runtimeOutputs = ensureStore(db, "runtime_outputs", { keyPath: "id" });
  runtimeOutputs?.createIndex("sessionId", "sessionId");
  runtimeOutputs?.createIndex("session_time", ["sessionId", "timestamp"]);
  runtimeOutputs?.createIndex("session_runtime", ["sessionId", "runtimeId"]);

  const interactionRecords = ensureStore(db, "interaction_records", {
    keyPath: "id",
  });
  interactionRecords?.createIndex("sessionId", "sessionId");
  interactionRecords?.createIndex("session_time", ["sessionId", "timestamp"]);
  interactionRecords?.createIndex("session_type", ["sessionId", "type"]);

  const ledger = ensureStore(db, "world_data_import_ledger", {
    keyPath: "id",
  });
  ledger?.createIndex("sessionId", "sessionId");
  ledger?.createIndex("source", ["sessionId", "sourceWorldId", "sourceId"]);

  const mediaAssets = ensureStore(db, "media_assets", { keyPath: "id" });
  mediaAssets?.createIndex("owner", ["ownerSessionId", "ownerPluginId"]);

  const mediaRefs = ensureStore(db, "media_refs", { keyPath: "key" });
  mediaRefs?.createIndex("sessionId", "sessionId");
  mediaRefs?.createIndex("mediaId", "mediaId");
  mediaRefs?.createIndex("session_media", ["sessionId", "mediaId"]);

  ensureStore(db, APP_KV_STORE_STATE_SNAPSHOTS);
  ensureStore(db, APP_KV_STORE_WORLD_OVERLAYS);
  ensureStore(db, APP_KV_STORE_STATE_PATCHES);
  ensureStore(db, APP_KV_STORE_SUBMITTED_BLOCKS);
  ensureStore(db, APP_KV_STORE_EXECUTION_STEPS);
  ensureStore(db, MEDIA_CACHE_STORE_BLOBS, { keyPath: "id" });
}
