/**
 * App-level IndexedDB key-value store for frontend-only data.
 *
 * Stores frontend-only records that are keyed by session/world ids:
 * state snapshots, world overlays, submitted block UI state, etc.
 */

import {
  APP_KV_STORE_EXECUTION_STEPS,
  APP_KV_STORE_STATE_PATCHES,
  APP_KV_STORE_STATE_SNAPSHOTS,
  APP_KV_STORE_SUBMITTED_BLOCKS,
  APP_KV_STORE_WORLD_OVERLAYS,
  BROWSER_IDB_SCHEMA_VERSION,
  upgradeBrowserIdbSchema,
} from "@covel/store/idb";
import {
  BROWSER_STORAGE_RESET_KEY,
  LEGACY_BROWSER_DATABASES,
  LEGACY_LOCAL_STORAGE_KEYS,
  LEGACY_LOCAL_STORAGE_PREFIXES,
} from "./storage/legacy-keys.js";
import { BROWSER_STORAGE_DB_NAME } from "./storage/data-store.js";

const DB_NAME = BROWSER_STORAGE_DB_NAME;
const DB_VERSION = BROWSER_IDB_SCHEMA_VERSION;

const STORE_STATE_SNAPSHOTS = APP_KV_STORE_STATE_SNAPSHOTS; // key: sessionId
const STORE_WORLD_OVERLAYS = APP_KV_STORE_WORLD_OVERLAYS; // key: worldId
const STORE_STATE_PATCHES = APP_KV_STORE_STATE_PATCHES; // key: sessionId
const STORE_SUBMITTED_BLOCKS = APP_KV_STORE_SUBMITTED_BLOCKS; // key: sessionId
const STORE_EXECUTION_STEPS = APP_KV_STORE_EXECUTION_STEPS; // key: sessionId

type StoreNames =
  | typeof STORE_STATE_SNAPSHOTS
  | typeof STORE_WORLD_OVERLAYS
  | typeof STORE_STATE_PATCHES
  | typeof STORE_SUBMITTED_BLOCKS
  | typeof STORE_EXECUTION_STEPS;

let dbPromise: Promise<IDBDatabase> | null = null;

function openAppDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      upgradeBrowserIdbSchema(req.result, event.oldVersion);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet<T>(
  storeName: StoreNames,
  key: string,
): Promise<T | null> {
  const db = await openAppDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut<T>(
  storeName: StoreNames,
  key: string,
  value: T,
): Promise<void> {
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

export async function getStateSnapshot(
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  return idbGet<Record<string, unknown>>(STORE_STATE_SNAPSHOTS, sessionId);
}

export async function saveStateSnapshot(
  sessionId: string,
  snapshot: Record<string, unknown>,
): Promise<void> {
  return idbPut(STORE_STATE_SNAPSHOTS, sessionId, snapshot);
}

export async function removeStateSnapshot(sessionId: string): Promise<void> {
  return idbDelete(STORE_STATE_SNAPSHOTS, sessionId);
}

// ── State Patches ───────────────────────────────────────────────

export async function getStatePatches(
  sessionId: string,
): Promise<import("./api.js").StatePatchRecord[] | null> {
  return idbGet<import("./api.js").StatePatchRecord[]>(
    STORE_STATE_PATCHES,
    sessionId,
  );
}

export async function saveStatePatches(
  sessionId: string,
  patches: import("./api.js").StatePatchRecord[],
): Promise<void> {
  return idbPut(STORE_STATE_PATCHES, sessionId, patches);
}

export async function removeStatePatches(sessionId: string): Promise<void> {
  return idbDelete(STORE_STATE_PATCHES, sessionId);
}

// ── World Overlays ───────────────────────────────────────────────

export interface WorldOverlay {
  lore?: string;
  updatedAt: string;
}

export async function getWorldOverlay(
  worldId: string,
): Promise<WorldOverlay | null> {
  return idbGet<WorldOverlay>(STORE_WORLD_OVERLAYS, worldId);
}

export async function setWorldOverlay(
  worldId: string,
  overlay: WorldOverlay,
): Promise<void> {
  return idbPut(STORE_WORLD_OVERLAYS, worldId, overlay);
}

export async function removeWorldOverlay(worldId: string): Promise<void> {
  return idbDelete(STORE_WORLD_OVERLAYS, worldId);
}

// ── Submitted Blocks ────────────────────────────────────────────

export interface SubmittedBlocksRecord {
  /** Ordered list of submitted block IDs (kept for backward compat with old code paths). */
  ids: string[];
  /** Form values keyed by blockId — used to repopulate disabled forms after submission. */
  values: Record<string, Record<string, unknown>>;
}

export async function getSubmittedBlocks(
  sessionId: string,
): Promise<SubmittedBlocksRecord> {
  const raw = await idbGet<unknown>(STORE_SUBMITTED_BLOCKS, sessionId);
  if (!raw) return { ids: [], values: {} };
  // Legacy shape: plain string[]. Migrate by treating values as empty.
  if (Array.isArray(raw)) return { ids: raw as string[], values: {} };
  const obj = raw as Partial<SubmittedBlocksRecord>;
  return { ids: obj.ids ?? [], values: obj.values ?? {} };
}

export async function saveSubmittedBlocks(
  sessionId: string,
  ids: string[],
  values: Record<string, Record<string, unknown>>,
): Promise<void> {
  return idbPut<SubmittedBlocksRecord>(STORE_SUBMITTED_BLOCKS, sessionId, {
    ids,
    values,
  });
}

export async function removeSubmittedBlocks(sessionId: string): Promise<void> {
  return idbDelete(STORE_SUBMITTED_BLOCKS, sessionId);
}

// ── Execution Steps (Timeline) ───────────────────────────────────

export async function getExecutionSteps(sessionId: string): Promise<unknown[]> {
  return (await idbGet<unknown[]>(STORE_EXECUTION_STEPS, sessionId)) ?? [];
}

export async function saveExecutionSteps(
  sessionId: string,
  steps: unknown[],
): Promise<void> {
  return idbPut(STORE_EXECUTION_STEPS, sessionId, steps);
}

export async function removeExecutionSteps(sessionId: string): Promise<void> {
  return idbDelete(STORE_EXECUTION_STEPS, sessionId);
}

// ── Legacy reset ──────────────────────────────────────────────────

function deleteDatabase(name: string): Promise<boolean> {
  if (typeof indexedDB === "undefined") return Promise.resolve(true);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(name);
    } catch {
      resolve(false);
      return;
    }
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
  });
}

function removeLegacyLocalStorageData(): void {
  if (typeof localStorage === "undefined") return;
  const keysToRemove: string[] = [];

  for (const key of LEGACY_LOCAL_STORAGE_KEYS) {
    keysToRemove.push(key);
  }

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (
      LEGACY_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      keysToRemove.push(key);
    }
  }

  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}

/**
 * One-time browser storage reset for early local data.
 *
 * The reset only touches the current browser/WebView origin: legacy
 * IndexedDB database names plus old frontend localStorage data keys. Desktop
 * SQLite files and media directories live outside this origin and are not
 * affected.
 */
export async function resetLegacyBrowserStorage(): Promise<void> {
  if (typeof localStorage !== "undefined") {
    try {
      if (localStorage.getItem(BROWSER_STORAGE_RESET_KEY) === "1") return;
    } catch {
      return;
    }
  }

  const deleted = await Promise.all(
    LEGACY_BROWSER_DATABASES.map((name) => deleteDatabase(name)),
  );

  try {
    removeLegacyLocalStorageData();
    if (deleted.every(Boolean)) {
      localStorage.setItem(BROWSER_STORAGE_RESET_KEY, "1");
    }
  } catch {
    // localStorage unavailable (private mode, quota) — reset remains best-effort.
  }
}

/**
 * Backward-compatible boot hook name. The early project reset deliberately
 * clears legacy browser data instead of migrating it.
 */
export async function migrateLocalStorageToIdb(): Promise<void> {
  try {
    await resetLegacyBrowserStorage();
  } catch {
    // IDB not available (e.g. private browsing) — keep boot non-fatal.
  }
}
