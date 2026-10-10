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

import type { DataStore, RuntimeStoreBackend, StoreConfig } from "./types.js";
import { readRuntimeEnv } from "@covel/shared";

/**
 * Create a `DataStore` instance for the specified backend.
 *
 * Loads only the selected backend. Both the root and factory entry points
 * keep backend implementations lazy.
 *
 * @param config - Store configuration specifying the backend (`memory`, `sqlite`, or `pg`) and connection details.
 * @returns A `DataStore` instance ready for use.
 * @throws When `backend` is `pg` and `databaseUrl` is missing, or when `backend` is unknown.
 *
 * @example
 * ```typescript
 * import { createStore } from '@covel/store';
 *
 * const memStore = await createStore({ backend: 'memory' });
 * const pgStore = await createStore({ backend: 'pg', databaseUrl: 'postgresql://user:pass@localhost/covel' });
 * ```
 */
export async function createStore(config: StoreConfig): Promise<DataStore> {
  switch (config.backend) {
    case "memory": {
      const { createMemoryStore } = await import("./memory/memory-store.js");
      return createMemoryStore();
    }
    case "sqlite": {
      const { createSqliteStore } = await import("./sqlite/sqlite-store.js");
      return createSqliteStore(config.sqlitePath ?? "./data/covel.db");
    }
    case "pg": {
      const { createPgStore } = await import("./postgres/pg-store.js");
      if (!config.databaseUrl)
        throw new Error("DATABASE_URL required for pg backend");
      return createPgStore(config.databaseUrl);
    }
    default:
      throw new Error(`Unknown store backend: ${String(config.backend)}`);
  }
}

/**
 * Create a `DataStore` from environment variables.
 *
 * Reads `STORE_BACKEND` (default: `sqlite`), `SQLITE_PATH`, and `DATABASE_URL`
 * from `process.env` and delegates to `createStore()`.
 *
 * @returns A `DataStore` instance configured from the current environment.
 *
 * @example
 * ```typescript
 * import { createStoreFromEnv } from '@covel/store';
 *
 * // With STORE_BACKEND=pg and DATABASE_URL set:
 * const store = await createStoreFromEnv();
 * ```
 */
export async function createStoreFromEnv(): Promise<DataStore> {
  const env = readRuntimeEnv();
  const config = {
    backend: env.storeBackend,
    sqlitePath: env.sqlitePath,
    databaseUrl: env.databaseUrl,
  };
  if (config.backend !== "sqlite" || config.sqlitePath === ":memory:")
    return createStore(config);

  // A server owns its SQLite file alone: a second process fails here, naming
  // the owner, instead of running on the same file.
  const { acquireSqliteLock } = await import("./sqlite/database-lock.js");
  const release = acquireSqliteLock(config.sqlitePath);
  try {
    const store = await createStore(config);
    const close = store.close.bind(store);
    store.close = async () => {
      try {
        await close();
      } finally {
        release();
      }
    };
    return store;
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Resolve the active store backend name from environment variables.
 *
 * Mirrors the logic used by {@link createStoreFromEnv}, exposed as a
 * separate helper so other modules (e.g. health checks, observability)
 * can report the same value without re-reading or guessing.
 */
export function resolveBackendFromEnv(): RuntimeStoreBackend {
  return readRuntimeEnv().storeBackend;
}

export {
  createMediaStore,
  createMediaStoreFromEnv,
} from "./media-store/factory.js";
