import type { MediaStore } from "@covel/shared";
import { readRuntimeEnv } from "@covel/shared";
import { resolve } from "node:path";
import { createMemoryMediaStore } from "./memory.js";
import { createPgMediaStore } from "./pg.js";
import { createSqliteMediaStore } from "./sqlite.js";
import type { MediaStoreBackend, MediaStoreConfig } from "./types.js";

function resolveMediaBackend(
  config: MediaStoreConfig,
): Exclude<MediaStoreBackend, "mirror"> {
  const requested = config.backend ?? "mirror";
  if (requested !== "mirror") return requested;
  const dataBackend = config.storeBackend ?? "sqlite";
  if (dataBackend === "idb") return "idb";
  return dataBackend;
}

export async function createMediaStore(
  config: MediaStoreConfig = {},
): Promise<MediaStore | undefined> {
  const backend = resolveMediaBackend(config);

  switch (backend) {
    case "none":
      return undefined;
    case "memory":
      return createMemoryMediaStore();
    case "sqlite": {
      const sqlitePath = resolve(config.sqlitePath ?? "./data/covel.db");
      return createSqliteMediaStore(sqlitePath, {
        mediaRoot: config.mediaRoot,
      });
    }
    case "pg": {
      if (!config.databaseUrl) return undefined;
      return createPgMediaStore(config.databaseUrl);
    }
    case "idb": {
      const { createIndexedDbMediaStore } =
        await import("../indexeddb/idb-media-store.js");
      return createIndexedDbMediaStore({
        dbName: config.idbDbName,
      });
    }
    default:
      throw new Error(`Unknown media store backend: ${String(backend)}`);
  }
}

export function createMediaStoreFromEnv(
  source?: Parameters<typeof readRuntimeEnv>[0],
): Promise<MediaStore | undefined> {
  const env = readRuntimeEnv(source);
  return createMediaStore({
    backend: env.mediaBackend,
    storeBackend: env.storeBackend,
    sqlitePath: env.sqlitePath,
    databaseUrl: env.databaseUrl,
    mediaRoot: env.mediaRoot,
  });
}
