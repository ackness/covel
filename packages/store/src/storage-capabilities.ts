import type { DataStore, StoreBackend } from "./types.js";
import type { MediaStore, MediaStoreBackend } from "./media-store.js";
import { STORAGE_MIGRATIONS } from "./migrations.js";
import { supportsVector } from "./vector-store.js";
import type { VectorBackend } from "./vector-store.js";

export type FrontendStorageMode = "local" | "remote";

export interface StorageCapabilityDescriptor {
  readonly data: {
    readonly backend: StoreBackend;
    readonly durable: boolean;
    readonly frontendMode: FrontendStorageMode;
  };
  readonly media: {
    readonly backend: Exclude<MediaStoreBackend, "mirror">;
    readonly configuredBackend: MediaStoreBackend;
    readonly enabled: boolean;
    readonly durable: boolean;
  };
  readonly vector: {
    readonly backend: VectorBackend;
    readonly capable: boolean;
    readonly driver:
      "in-memory" | "sqlite-vec" | "pgvector" | "external" | "none";
    readonly modelCount: number;
    readonly tableCount: number;
  };
  readonly migrations: typeof STORAGE_MIGRATIONS;
}

export interface DescribeStorageCapabilitiesOptions {
  readonly dataBackend: StoreBackend;
  readonly mediaBackend?: MediaStoreBackend;
  readonly vectorBackend?: VectorBackend;
  readonly store: DataStore;
  readonly mediaStore?: MediaStore;
}

function effectiveMediaBackend(
  dataBackend: StoreBackend,
  mediaBackend: MediaStoreBackend,
): Exclude<MediaStoreBackend, "mirror"> {
  if (mediaBackend !== "mirror") return mediaBackend;
  return dataBackend;
}

function isDurableDataBackend(backend: StoreBackend): boolean {
  return backend === "sqlite" || backend === "pg" || backend === "idb";
}

function isDurableMediaBackend(
  backend: Exclude<MediaStoreBackend, "mirror">,
): boolean {
  return backend === "sqlite" || backend === "pg" || backend === "idb";
}

function vectorDriver(
  dataBackend: StoreBackend,
  vectorBackend: VectorBackend,
  capable: boolean,
): StorageCapabilityDescriptor["vector"]["driver"] {
  if (vectorBackend === "none") return "none";
  if (vectorBackend === "external") return "external";
  if (!capable) return "none";
  if (dataBackend === "memory") return "in-memory";
  if (dataBackend === "sqlite") return "sqlite-vec";
  if (dataBackend === "pg") return "pgvector";
  return "none";
}

export async function describeStorageCapabilities(
  options: DescribeStorageCapabilitiesOptions,
): Promise<StorageCapabilityDescriptor> {
  const configuredMediaBackend = options.mediaBackend ?? "mirror";
  const mediaBackend = effectiveMediaBackend(
    options.dataBackend,
    configuredMediaBackend,
  );
  const vectorBackend = options.vectorBackend ?? "embedded";
  const vectorStore =
    vectorBackend === "embedded" && supportsVector(options.store);

  let modelCount = 0;
  let tableCount = 0;
  if (vectorStore) {
    try {
      const models = await options.store.listVectorModels();
      modelCount = models.length;
      tableCount = models.length;
    } catch {
      modelCount = 0;
      tableCount = 0;
    }
  }

  return {
    data: {
      backend: options.dataBackend,
      durable: isDurableDataBackend(options.dataBackend),
      frontendMode: options.dataBackend === "memory" ? "local" : "remote",
    },
    media: {
      backend: mediaBackend,
      configuredBackend: configuredMediaBackend,
      enabled: mediaBackend !== "none" && Boolean(options.mediaStore),
      durable: isDurableMediaBackend(mediaBackend),
    },
    vector: {
      backend: vectorBackend,
      capable: vectorStore,
      driver: vectorDriver(options.dataBackend, vectorBackend, vectorStore),
      modelCount,
      tableCount,
    },
    migrations: STORAGE_MIGRATIONS,
  };
}
