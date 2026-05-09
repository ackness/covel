import type { BrowserIdbDatabase, IdbStoreName } from "./idb-db.js";

export interface IdbMutationTracker {
  ensureStoreSnapshot(name: IdbStoreName): Promise<void>;
  putAndTrack(name: IdbStoreName, value: unknown): Promise<void>;
  deleteAndTrack(name: IdbStoreName, key: unknown): Promise<void>;
  beginTx(): Promise<void>;
  commitTx(): Promise<void>;
  rollbackTx(): Promise<void>;
}

export function createIdbMutationTracker(
  db: BrowserIdbDatabase,
): IdbMutationTracker {
  let idbSnapshot: Map<string, unknown[]> | null = null;
  let touchedStores: Set<string> | null = null;

  async function ensureStoreSnapshot(name: IdbStoreName): Promise<void> {
    if (!touchedStores || !idbSnapshot) return;
    if (touchedStores.has(name)) return;
    touchedStores.add(name);
    const rows = await db.getAll(name);
    idbSnapshot.set(name, structuredClone(rows));
  }

  async function putAndTrack(
    name: IdbStoreName,
    value: unknown,
  ): Promise<void> {
    await ensureStoreSnapshot(name);
    await db.put(name, value as Record<string, unknown>);
  }

  async function deleteAndTrack(
    name: IdbStoreName,
    key: unknown,
  ): Promise<void> {
    await ensureStoreSnapshot(name);
    await db.delete(name, key as IDBValidKey);
  }

  async function restoreTouchedStores(
    names: Set<string>,
    snap: Map<string, unknown[]>,
  ): Promise<void> {
    for (const name of names) {
      const tx = db.transaction(name as IdbStoreName, "readwrite");
      await tx.store.clear();
      const rows = snap.get(name) ?? [];
      for (const row of rows) {
        await tx.store.put(row as Record<string, unknown>);
      }
      await tx.done;
    }
  }

  return {
    ensureStoreSnapshot,
    putAndTrack,
    deleteAndTrack,

    async beginTx(): Promise<void> {
      if (touchedStores !== null || idbSnapshot !== null) {
        throw new Error(
          "IdbStore: nested transactions are not supported (beginTx called while another tx is active)",
        );
      }
      touchedStores = new Set();
      idbSnapshot = new Map();
    },

    async commitTx(): Promise<void> {
      if (touchedStores === null || idbSnapshot === null) {
        throw new Error(
          "IdbStore: commitTx called without an active transaction",
        );
      }
      touchedStores = null;
      idbSnapshot = null;
    },

    async rollbackTx(): Promise<void> {
      if (touchedStores === null || idbSnapshot === null) {
        throw new Error(
          "IdbStore: rollbackTx called without an active transaction",
        );
      }
      const touched = touchedStores;
      const snapshot = idbSnapshot;
      touchedStores = null;
      idbSnapshot = null;
      await restoreTouchedStores(touched, snapshot);
    },
  };
}
