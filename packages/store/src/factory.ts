/**
 * Store factory — creates the appropriate DataStore based on config.
 *
 * Usage:
 *   const store = await createStore({ backend: 'sqlite' });
 *   const store = await createStore({ backend: 'pg', databaseUrl: '...' });
 *   const store = await createStore({ backend: 'memory' });
 *
 * Environment variable shortcut:
 *   const store = await createStoreFromEnv();
 *   // Reads STORE_BACKEND, SQLITE_PATH, DATABASE_URL from process.env
 */

import type { DataStore, StoreConfig } from './types.js';

export async function createStore(config: StoreConfig): Promise<DataStore> {
  switch (config.backend) {
    case 'memory': {
      const { createMemoryStore } = await import('./memory/memory-store.js');
      return createMemoryStore();
    }
    case 'sqlite': {
      const { createSqliteStore } = await import('./sqlite/sqlite-store.js');
      return createSqliteStore(config.sqlitePath ?? './data/covel.db');
    }
    case 'pg': {
      const { createPgStore } = await import('./postgres/pg-store.js');
      if (!config.databaseUrl) throw new Error('DATABASE_URL required for pg backend');
      return createPgStore(config.databaseUrl);
    }
    default:
      throw new Error(`Unknown store backend: ${String(config.backend)}`);
  }
}

export function createStoreFromEnv(): Promise<DataStore> {
  const backend = (process.env.STORE_BACKEND ?? 'sqlite') as StoreConfig['backend'];
  return createStore({
    backend,
    sqlitePath: process.env.SQLITE_PATH ?? './data/covel.db',
    databaseUrl: process.env.DATABASE_URL,
  });
}
