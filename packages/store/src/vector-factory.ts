import { readRuntimeEnv } from "@covel/shared";
import { createStore } from "./factory.js";
import type { DataStore, StoreConfig } from "./types.js";
import {
  supportsVector,
  type VectorModelOps,
  type VectorStoreCapability,
} from "./vector-store.js";

export type VectorBackend = "embedded" | "none" | "external";
export type VectorStore = VectorStoreCapability & VectorModelOps;

export interface VectorStoreConfig {
  readonly backend?: VectorBackend;
  readonly dataStore?: DataStore;
  readonly storeConfig?: StoreConfig;
  readonly externalStore?: VectorStore;
}

export async function createVectorStore(
  config: VectorStoreConfig = {},
): Promise<VectorStore | undefined> {
  const backend = config.backend ?? "embedded";
  if (backend === "none") return undefined;
  if (backend === "external") {
    if (config.externalStore) return config.externalStore;
    throw new Error(
      "VECTOR_BACKEND=external requires an external vector store adapter",
    );
  }

  const store =
    config.dataStore ??
    (config.storeConfig ? await createStore(config.storeConfig) : undefined);
  if (!store) return undefined;
  return supportsVector(store) ? store : undefined;
}

export function resolveVectorBackendFromEnv(): VectorBackend {
  return readRuntimeEnv().vectorBackend;
}

export async function createVectorStoreFromEnv(
  dataStore?: DataStore,
): Promise<VectorStore | undefined> {
  const env = readRuntimeEnv();
  return createVectorStore({
    backend: env.vectorBackend,
    dataStore,
    storeConfig: dataStore
      ? undefined
      : {
          backend: env.storeBackend,
          sqlitePath: env.sqlitePath,
          databaseUrl: env.databaseUrl,
        },
  });
}
