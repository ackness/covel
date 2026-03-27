/**
 * IDB StorageAdapter — IndexedDB-backed implementation for local/ephemeral mode.
 *
 * Uses the v2 storage stores (storage_kv, storage_log, storage_graph)
 * managed by localDb.ts. Does NOT own the DB connection.
 */
import type { Scope, StorageAdapter } from './types';
import { openDb } from '../localDb';

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export class IdbStorageAdapter implements StorageAdapter {
  async kvGet(
    scope: Scope, ns: string, collection: string, key: string,
  ): Promise<unknown | null> {
    const db = await openDb();
    const store = db.transaction('storage_kv', 'readonly').objectStore('storage_kv');
    const row = await promisify<{ value: unknown } | undefined>(
      store.get([scope, ns, collection, key]),
    );
    return row?.value ?? null;
  }

  async kvSet(
    scope: Scope, ns: string, collection: string, key: string, value: unknown,
  ): Promise<void> {
    const db = await openDb();
    const t = db.transaction('storage_kv', 'readwrite');
    t.objectStore('storage_kv').put({ scope, ns, collection, key, value });
    await txDone(t);
  }

  async kvQuery(
    scope: Scope, ns: string, collection: string,
  ): Promise<Record<string, unknown>> {
    const db = await openDb();
    const store = db.transaction('storage_kv', 'readonly').objectStore('storage_kv');
    const rows = await promisify<{ key: string; value: unknown }[]>(
      store.index('by_collection').getAll([scope, ns, collection]),
    );
    const result: Record<string, unknown> = {};
    for (const r of rows) result[r.key] = r.value;
    return result;
  }

  async kvDelete(
    scope: Scope, ns: string, collection: string, key: string,
  ): Promise<void> {
    const db = await openDb();
    const t = db.transaction('storage_kv', 'readwrite');
    t.objectStore('storage_kv').delete([scope, ns, collection, key]);
    await txDone(t);
  }

  async logAppend(
    scope: Scope, ns: string, collection: string, entry: unknown,
  ): Promise<void> {
    const db = await openDb();
    const t = db.transaction('storage_log', 'readwrite');
    t.objectStore('storage_log').add({
      scope, ns, collection, entry,
      created_at: new Date().toISOString(),
    });
    await txDone(t);
  }

  async logQuery(
    scope: Scope, ns: string, collection: string, limit = 50,
  ): Promise<unknown[]> {
    const db = await openDb();
    const store = db.transaction('storage_log', 'readonly').objectStore('storage_log');
    const all = await promisify<{ entry: unknown }[]>(
      store.index('by_collection').getAll([scope, ns, collection]),
    );
    return all.slice(-limit).map((r) => r.entry);
  }

  async graphAdd(
    scope: Scope, ns: string,
    fromId: string, toId: string, relation: string, data?: unknown,
  ): Promise<void> {
    const db = await openDb();
    const t = db.transaction('storage_graph', 'readwrite');
    t.objectStore('storage_graph').put({
      scope, ns, from_id: fromId, to_id: toId, relation, data,
    });
    await txDone(t);
  }

  async graphQuery(
    scope: Scope, ns: string, _collection: string, nodeId?: string,
  ): Promise<unknown[]> {
    const db = await openDb();
    const store = db.transaction('storage_graph', 'readonly').objectStore('storage_graph');
    type Row = {
      scope: string; ns: string;
      from_id: string; to_id: string; relation: string; data: unknown;
    };
    const all = await promisify<Row[]>(store.getAll());
    return all.filter(
      (r) =>
        r.scope === scope &&
        r.ns === ns &&
        (!nodeId || r.from_id === nodeId || r.to_id === nodeId),
    );
  }
}
