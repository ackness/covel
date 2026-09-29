import type { StoreBackend } from "../types.js";

export type MediaStoreBackend =
  "mirror" | "memory" | "sqlite" | "pg" | "idb" | "none";

export interface MediaStoreConfig {
  readonly backend?: MediaStoreBackend;
  readonly storeBackend?: StoreBackend;
  readonly sqlitePath?: string;
  readonly databaseUrl?: string;
  readonly mediaRoot?: string;
  readonly idbDbName?: string;
}

export interface SqliteMediaStoreOptions {
  readonly mediaRoot?: string;
}

export interface PgMediaStoreOptions {
  readonly freshSchema?: boolean;
}
