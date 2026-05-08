import type { StoreBackend } from "./types.js";
import type { MediaStoreBackend } from "./media-store.js";
import {
  BROWSER_IDB_DATABASE_NAME,
  BROWSER_IDB_SCHEMA_VERSION,
} from "./indexeddb/idb-schema.js";

export { BROWSER_IDB_DATABASE_NAME };
export const IDB_BROWSER_STORAGE_SCHEMA_VERSION = BROWSER_IDB_SCHEMA_VERSION;
export const IDB_DATA_STORE_SCHEMA_VERSION = BROWSER_IDB_SCHEMA_VERSION;
export const IDB_MEDIA_STORE_SCHEMA_VERSION = BROWSER_IDB_SCHEMA_VERSION;

export type StorageMigrationDomain = "data" | "media" | "vector" | "browser";
export type StorageMigrationStatus =
  | "current"
  | "managed-by-backend"
  | "manual-required"
  | "not-applicable";

export interface StorageMigrationResult {
  readonly id: string;
  readonly version: number;
  readonly status: StorageMigrationStatus;
}

export interface StorageMigrationDescriptor {
  readonly id: string;
  readonly domain: StorageMigrationDomain;
  readonly backend: StoreBackend | MediaStoreBackend | "embedded";
  readonly status: StorageMigrationStatus;
  readonly description: string;
  currentVersion(): number;
  migrate(): Promise<StorageMigrationResult>;
}

export interface StorageMigrationSummary {
  readonly id: string;
  readonly domain: StorageMigrationDomain;
  readonly backend: StoreBackend | MediaStoreBackend | "embedded";
  readonly version: number;
  readonly status: StorageMigrationStatus;
  readonly description: string;
}

function staticMigration(
  input: Omit<StorageMigrationDescriptor, "currentVersion" | "migrate"> & {
    readonly version: number;
  },
): StorageMigrationDescriptor {
  return {
    id: input.id,
    domain: input.domain,
    backend: input.backend,
    status: input.status,
    description: input.description,
    currentVersion: () => input.version,
    migrate: async () => ({
      id: input.id,
      version: input.version,
      status: input.status,
    }),
  };
}

const REGISTRY: readonly StorageMigrationDescriptor[] = [
  staticMigration({
    id: "browser:idb:unified-storage",
    domain: "browser",
    backend: "idb",
    version: IDB_BROWSER_STORAGE_SCHEMA_VERSION,
    status: "managed-by-backend",
    description:
      "Browser-local data, media, app-KV, and render cache share the covel-browser IndexedDB schema.",
  }),
  staticMigration({
    id: "data:sqlite:schema",
    domain: "data",
    backend: "sqlite",
    version: 1,
    status: "manual-required",
    description:
      "SQLite schema migrations run through the server Drizzle migration path.",
  }),
  staticMigration({
    id: "data:pg:schema",
    domain: "data",
    backend: "pg",
    version: 1,
    status: "manual-required",
    description:
      "PostgreSQL schema migrations run through the server Drizzle migration path.",
  }),
  staticMigration({
    id: "data:idb:store",
    domain: "data",
    backend: "idb",
    version: IDB_DATA_STORE_SCHEMA_VERSION,
    status: "managed-by-backend",
    description:
      "IndexedDB DataStore upgrades through the idb openDB upgrade callback.",
  }),
  staticMigration({
    id: "media:idb:store",
    domain: "media",
    backend: "idb",
    version: IDB_MEDIA_STORE_SCHEMA_VERSION,
    status: "managed-by-backend",
    description:
      "IndexedDB MediaStore upgrades through the idb openDB upgrade callback.",
  }),
  staticMigration({
    id: "vector:embedded:model-registry",
    domain: "vector",
    backend: "embedded",
    version: 1,
    status: "managed-by-backend",
    description:
      "Embedded vector stores manage vector_models and per-model physical tables in the active DataStore.",
  }),
];

export function getStorageMigrationRegistry(): readonly StorageMigrationDescriptor[] {
  return REGISTRY;
}

export function summarizeStorageMigrations(
  registry: readonly StorageMigrationDescriptor[] = REGISTRY,
): readonly StorageMigrationSummary[] {
  return registry.map((item) => ({
    id: item.id,
    domain: item.domain,
    backend: item.backend,
    version: item.currentVersion(),
    status: item.status,
    description: item.description,
  }));
}
