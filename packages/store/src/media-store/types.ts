import type { StoreBackend } from "../types.js";

export type MediaStoreBackend =
  | "mirror"
  | "memory"
  | "sqlite"
  | "pg"
  | "idb"
  | "none";

export interface MediaStoreConfig {
  readonly backend?: MediaStoreBackend;
  readonly storeBackend?: StoreBackend;
  readonly sqlitePath?: string;
  readonly databaseUrl?: string;
  readonly mediaRoot?: string;
  readonly idbDbName?: string;
}

// Re-export the shared MediaStore wire-shape interfaces so existing
// `import { MediaStore, ... } from "@covel/store"` call sites keep
// working without churn. The canonical definitions now live in
// `@covel/shared/src/types/media.ts` so browser code can reference
// the contract without dragging Node-only modules into the bundle.
export type {
  MediaAssetLookup,
  MediaAssetRecord,
  MediaCleanupResult,
  MediaLifecyclePolicy,
  MediaRefRecord,
  MediaStore,
} from "@covel/shared";

export interface SqliteMediaStoreOptions {
  readonly mediaRoot?: string;
}

export interface PgMediaStoreOptions {
  readonly freshSchema?: boolean;
}
