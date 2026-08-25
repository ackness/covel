/** Lightweight browser cache/media schema. Business data lives in BrowserVault. */
export const BROWSER_IDB_SCHEMA_VERSION = 1;
export const BROWSER_IDB_DATABASE_NAME = "covel-browser-cache";

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
}

function ensureStore(
  db: BrowserSchemaDatabase,
  name: string,
  options?: IDBObjectStoreParameters,
): BrowserSchemaStore | null {
  if (db.objectStoreNames.contains(name)) return null;
  return db.createObjectStore(name, options);
}

export function upgradeBrowserIdbSchema(
  db: BrowserSchemaDatabase,
  _oldVersion?: number,
  _transaction?: unknown,
): Promise<void> {
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
  return Promise.resolve();
}
