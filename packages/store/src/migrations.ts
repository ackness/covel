import type { StoreBackend } from "./types.js";
import type { MediaStoreBackend } from "./media-store.js";
import {
  BROWSER_IDB_DATABASE_NAME,
  BROWSER_IDB_SCHEMA_VERSION,
} from "./indexeddb/idb-schema.js";

export { BROWSER_IDB_DATABASE_NAME };

/**
 * Version of the SQL data schema (SQLite and PostgreSQL share it). Each boot
 * records it in the database (SQLite `PRAGMA user_version`, PostgreSQL
 * `covel_schema_meta`) and refuses a database recorded with another one. Raise
 * it whenever a column changes in a way an existing database cannot follow;
 * `tests/schema-version.test.ts` fails when the table shapes change without it.
 */
export const DATA_SCHEMA_VERSION = 6;

export type StorageMigrationDomain = "data" | "media" | "vector" | "browser";
export type StorageMigrationStatus =
  "current" | "managed-by-backend" | "manual-required" | "not-applicable";

export interface StorageMigrationSummary {
  readonly id: string;
  readonly domain: StorageMigrationDomain;
  readonly backend: StoreBackend | MediaStoreBackend | "idb" | "embedded";
  readonly version: number;
  readonly status: StorageMigrationStatus;
  readonly description: string;
}

const REGISTRY: readonly StorageMigrationSummary[] = [
  {
    id: "browser:idb:cache-media",
    domain: "browser",
    backend: "idb",
    version: BROWSER_IDB_SCHEMA_VERSION,
    status: "managed-by-backend",
    description:
      "Browser UI state and media caches use a lightweight IndexedDB schema; durable game data lives in the separate Dexie BrowserVault.",
  },
  {
    id: "data:sqlite:schema",
    domain: "data",
    backend: "sqlite",
    version: DATA_SCHEMA_VERSION,
    status: "managed-by-backend",
    description:
      "SQLite creates the current data schema directly and records its version in PRAGMA user_version; a database written with another version is refused, not upgraded.",
  },
  {
    id: "data:pg:schema",
    domain: "data",
    backend: "pg",
    version: DATA_SCHEMA_VERSION,
    status: "managed-by-backend",
    description:
      "PostgreSQL creates the current data schema directly and records its version in covel_schema_meta; a database written with another version is refused, not upgraded.",
  },
  {
    id: "vector:embedded:model-registry",
    domain: "vector",
    backend: "embedded",
    version: 1,
    status: "managed-by-backend",
    description:
      "Embedded vector stores manage vector_models and per-model physical tables in the active DataStore.",
  },
];

/** The storage migrations this build knows about. */
export const STORAGE_MIGRATIONS: readonly StorageMigrationSummary[] = REGISTRY;
