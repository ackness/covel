import type { StoreBackend } from "./types.js";
import type { MediaStoreBackend } from "./media-store.js";
import {
  BROWSER_IDB_DATABASE_NAME,
  BROWSER_IDB_SCHEMA_VERSION,
} from "./indexeddb/idb-schema.js";

export { BROWSER_IDB_DATABASE_NAME };

export type StorageMigrationDomain = "data" | "media" | "vector" | "browser";
export type StorageMigrationStatus =
  "current" | "managed-by-backend" | "manual-required" | "not-applicable";

export interface StorageMigrationSummary {
  readonly id: string;
  readonly domain: StorageMigrationDomain;
  readonly backend: StoreBackend | MediaStoreBackend | "embedded";
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
    version: 2,
    status: "managed-by-backend",
    description:
      "SQLite boot migration preserves legacy rows while re-keying characters and lorebook entries by session.",
  },
  {
    id: "data:pg:schema",
    domain: "data",
    backend: "pg",
    version: 2,
    status: "managed-by-backend",
    description:
      "PostgreSQL boot migration preserves legacy rows while re-keying characters and lorebook entries by session.",
  },
  {
    id: "media:idb:store",
    domain: "media",
    backend: "idb",
    version: BROWSER_IDB_SCHEMA_VERSION,
    status: "managed-by-backend",
    description:
      "IndexedDB MediaStore upgrades through the idb openDB upgrade callback.",
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
