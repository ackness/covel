/**
 * App-level IndexedDB key-value store for frontend-only data.
 *
 * Stores game data that was previously in localStorage and could
 * exceed the ~5 MB quota (state snapshots, world overlays, etc.).
 *
 * Uses a separate IDB database (`covel-app`) so it doesn't
 * interfere with the `@covel/store` DataStore schema.
 */

const DB_NAME = "covel-app";
const DB_VERSION = 1;

const STORE_STATE_SNAPSHOTS = "stateSnapshots"; // key: sessionId
const STORE_WORLD_OVERLAYS = "worldOverlays"; // key: worldId

type StoreNames = typeof STORE_STATE_SNAPSHOTS | typeof STORE_WORLD_OVERLAYS;

let dbPromise: Promise<IDBDatabase> | null = null;

function openAppDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_STATE_SNAPSHOTS)) {
        db.createObjectStore(STORE_STATE_SNAPSHOTS);
      }
      if (!db.objectStoreNames.contains(STORE_WORLD_OVERLAYS)) {
        db.createObjectStore(STORE_WORLD_OVERLAYS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet<T>(storeName: StoreNames, key: string): Promise<T | null> {
  const db = await openAppDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut<T>(storeName: StoreNames, key: string, value: T): Promise<void> {
  const db = await openAppDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(storeName: StoreNames, key: string): Promise<void> {
  const db = await openAppDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── State Snapshots ──────────────────────────────────────────────

export async function getStateSnapshot(sessionId: string): Promise<Record<string, unknown> | null> {
  return idbGet<Record<string, unknown>>(STORE_STATE_SNAPSHOTS, sessionId);
}

export async function saveStateSnapshot(sessionId: string, snapshot: Record<string, unknown>): Promise<void> {
  return idbPut(STORE_STATE_SNAPSHOTS, sessionId, snapshot);
}

export async function removeStateSnapshot(sessionId: string): Promise<void> {
  return idbDelete(STORE_STATE_SNAPSHOTS, sessionId);
}

// ── World Overlays ───────────────────────────────────────────────

export interface WorldOverlay {
  lore?: string;
  updatedAt: string;
}

export async function getWorldOverlay(worldId: string): Promise<WorldOverlay | null> {
  return idbGet<WorldOverlay>(STORE_WORLD_OVERLAYS, worldId);
}

export async function setWorldOverlay(worldId: string, overlay: WorldOverlay): Promise<void> {
  return idbPut(STORE_WORLD_OVERLAYS, worldId, overlay);
}

export async function removeWorldOverlay(worldId: string): Promise<void> {
  return idbDelete(STORE_WORLD_OVERLAYS, worldId);
}

// ── Migration ────────────────────────────────────────────────────

const MIGRATED_KEY = "covel:idbMigrated";

/**
 * One-time migration: move state snapshots and world overlays
 * from localStorage to IndexedDB.
 *
 * Idempotent — safe to call on every app boot.
 */
export async function migrateLocalStorageToIdb(): Promise<void> {
  if (localStorage.getItem(MIGRATED_KEY) === "1") return;

  try {
    const keysToRemove: string[] = [];

    // Migrate state snapshots
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith("covel:stateSnapshot:")) {
        const sessionId = key.slice("covel:stateSnapshot:".length);
        const raw = localStorage.getItem(key);
        if (raw) {
          try {
            const data = JSON.parse(raw) as Record<string, unknown>;
            await saveStateSnapshot(sessionId, data);
            keysToRemove.push(key);
          } catch {
            // Skip corrupt entries
          }
        }
      }
      if (key.startsWith("covel:worldOverlay:")) {
        const worldId = key.slice("covel:worldOverlay:".length);
        const raw = localStorage.getItem(key);
        if (raw) {
          try {
            const data = JSON.parse(raw) as WorldOverlay;
            await setWorldOverlay(worldId, data);
            keysToRemove.push(key);
          } catch {
            // Skip corrupt entries
          }
        }
      }
    }

    // Clean up localStorage after successful migration
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }

    localStorage.setItem(MIGRATED_KEY, "1");
  } catch {
    // IDB not available (e.g. private browsing) — keep localStorage fallback
  }
}
