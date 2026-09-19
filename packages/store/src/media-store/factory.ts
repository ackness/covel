import type { MediaStore } from "@covel/shared";
import { readRuntimeEnv } from "@covel/shared";
import { resolve } from "node:path";
import type { MediaStoreBackend, MediaStoreConfig } from "./types.js";

function resolveMediaBackend(
  config: MediaStoreConfig,
): Exclude<MediaStoreBackend, "mirror"> {
  const requested = config.backend ?? "mirror";
  if (requested !== "mirror") return requested;
  const dataBackend = config.storeBackend ?? "sqlite";
  return dataBackend;
}

export async function createMediaStore(
  config: MediaStoreConfig = {},
): Promise<MediaStore | undefined> {
  const backend = resolveMediaBackend(config);

  switch (backend) {
    case "none":
      return undefined;
    case "memory": {
      const { createMemoryMediaStore } = await import("./memory.js");
      return createMemoryMediaStore();
    }
    case "sqlite": {
      const { createSqliteMediaStore } = await import("./sqlite.js");
      const sqlitePath = resolve(config.sqlitePath ?? "./data/covel.db");
      return createSqliteMediaStore(sqlitePath, {
        mediaRoot: config.mediaRoot,
      });
    }
    case "pg": {
      const { createPgMediaStore } = await import("./pg.js");
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
