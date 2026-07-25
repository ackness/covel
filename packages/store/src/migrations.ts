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
    id: "browser:idb:unified-storage",
    domain: "browser",
    backend: "idb",
    version: BROWSER_IDB_SCHEMA_VERSION,
    status: "managed-by-backend",
    description:
      "Browser-local data, media, app-KV, and render cache share the covel-browser IndexedDB schema.",
  },
  {
    id: "data:sqlite:schema",
    domain: "data",
    backend: "sqlite",
    version: 1,
    status: "manual-required",
    description:
      "SQLite schema migrations run through the server Drizzle migration path.",
  },
  {
    id: "data:pg:schema",
    domain: "data",
    backend: "pg",
    version: 1,
    status: "manual-required",
    description:
      "PostgreSQL schema migrations run through the server Drizzle migration path.",
  },
  {
    id: "data:idb:store",
    domain: "data",
    backend: "idb",
    version: BROWSER_IDB_SCHEMA_VERSION,
    status: "managed-by-backend",
    description:
      "IndexedDB DataStore upgrades through the idb openDB upgrade callback.",
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
