import type { DataStore } from "./types.js";

export type StoreBackend = "memory" | "indexeddb" | "postgres";

export interface StoreConfig {
  backend: StoreBackend;
  /** PostgreSQL connection URL (required for postgres backend) */
  databaseUrl?: string;
  /** IndexedDB database name (default: "covel") */
  dbName?: string;
  /** IndexedDB schema version (default: 1) */
  dbVersion?: number;
}

export async function createStore(config: StoreConfig): Promise<DataStore> {
  switch (config.backend) {
    case "memory": {
      const { MemoryStore } = await import("./memory/memory-store.js");
      return new MemoryStore();
    }
    case "indexeddb": {
      const { IdbStore } = await import("./indexeddb/idb-store.js");
      return new IdbStore({
        dbName: config.dbName,
        dbVersion: config.dbVersion,
      });
    }
    case "postgres": {
      if (!config.databaseUrl) {
        throw new Error("databaseUrl is required for postgres backend");
      }
      const { PgStore } = await import("./postgres/pg-store.js");
      const store = new PgStore({ databaseUrl: config.databaseUrl });
      await store.initialize();
      return store;
    }
    default:
      throw new Error(`Unknown store backend: ${config.backend as string}`);
  }
}
