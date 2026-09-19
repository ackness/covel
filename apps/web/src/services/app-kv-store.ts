/**
 * App-level IndexedDB key-value store for frontend-only data.
 *
 * Stores frontend-only records that are keyed by session/world ids:
 * state patches, world overlays, submitted block UI state, etc.
 */

// Backend-free cache schema constants.
import {
  APP_KV_STORE_EXECUTION_STEPS,
  APP_KV_STORE_STATE_PATCHES,
  APP_KV_STORE_SUBMITTED_BLOCKS,
  APP_KV_STORE_WORLD_OVERLAYS,
} from "@covel/store/idb-schema";
import { mergeExecutionHistory } from "./execution-history.js";
import { openBrowserCacheDb } from "./storage/cache-db.js";
import type { StatePatchRecord } from "./api/types.js";

const STORE_WORLD_OVERLAYS = APP_KV_STORE_WORLD_OVERLAYS; // key: worldId
const STORE_STATE_PATCHES = APP_KV_STORE_STATE_PATCHES; // key: sessionId
const STORE_SUBMITTED_BLOCKS = APP_KV_STORE_SUBMITTED_BLOCKS; // key: sessionId
const STORE_EXECUTION_STEPS = APP_KV_STORE_EXECUTION_STEPS; // key: sessionId

type StoreNames =
  | typeof STORE_WORLD_OVERLAYS
  | typeof STORE_STATE_PATCHES
  | typeof STORE_SUBMITTED_BLOCKS
  | typeof STORE_EXECUTION_STEPS;

async function idbGet<T>(
  storeName: StoreNames,
  key: string,
): Promise<T | null> {
  const db = await openBrowserCacheDb();
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
  const owned = structuredClone(value);
  const db = await openBrowserCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    store.put(owned, key);
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("Cache write transaction aborted"));
  });
}

async function idbDelete(storeName: StoreNames, key: string): Promise<void> {
  const db = await openBrowserCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("Cache deletion transaction aborted"));
  });
}

// ── State Patches ───────────────────────────────────────────────

export async function getStatePatches(
  sessionId: string,
): Promise<StatePatchRecord[] | null> {
  return idbGet<StatePatchRecord[]>(STORE_STATE_PATCHES, sessionId);
}

export async function appendStatePatch(patch: StatePatchRecord): Promise<void> {
  const owned = structuredClone(patch);
  const db = await openBrowserCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STATE_PATCHES, "readwrite");
    const store = tx.objectStore(STORE_STATE_PATCHES);
    const req = store.get(owned.sessionId);
    req.onsuccess = () => {
      const current = (req.result as StatePatchRecord[] | undefined) ?? [];
      store.put([...current, owned], owned.sessionId);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("State patch transaction aborted"));
  });
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
  /** Ordered list of submitted block IDs. */
  ids: string[];
  /** Form values keyed by blockId — used to repopulate disabled forms after submission. */
  values: Record<string, Record<string, unknown>>;
}

export async function getSubmittedBlocks(
  sessionId: string,
): Promise<SubmittedBlocksRecord> {
  const raw = await idbGet<SubmittedBlocksRecord>(
    STORE_SUBMITTED_BLOCKS,
    sessionId,
  );
  if (!raw) return { ids: [], values: {} };
  return raw;
}

export async function saveSubmittedBlocks(
  sessionId: string,
  ids: string[],
  values: Record<string, Record<string, unknown>>,
): Promise<void> {
  const owned = structuredClone({ ids, values });
  const db = await openBrowserCacheDb();
  return new Promise((resolve, reject) => {
    // One readwrite transaction serializes concurrent submissions, including
    // writes from another tab, without dropping previously submitted forms.
    const tx = db.transaction(STORE_SUBMITTED_BLOCKS, "readwrite");
    const store = tx.objectStore(STORE_SUBMITTED_BLOCKS);
    const req = store.get(sessionId);
    req.onsuccess = () => {
      const current = req.result as SubmittedBlocksRecord | undefined;
      store.put(
        {
          ids: [...new Set([...(current?.ids ?? []), ...owned.ids])],
          values: { ...current?.values, ...owned.values },
        } satisfies SubmittedBlocksRecord,
        sessionId,
      );
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("Submitted blocks transaction aborted"));
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
  const owned = structuredClone(steps);
  const db = await openBrowserCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_EXECUTION_STEPS, "readwrite");
    const store = tx.objectStore(STORE_EXECUTION_STEPS);
    let failure: unknown;
    const req = store.get(sessionId);
    req.onsuccess = () => {
      try {
        store.put(mergeExecutionHistory(req.result ?? [], owned), sessionId);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        failure ??
          tx.error ??
          new Error("Execution history transaction aborted"),
      );
  });
}

export async function removeExecutionSteps(sessionId: string): Promise<void> {
  return idbDelete(STORE_EXECUTION_STEPS, sessionId);
}
