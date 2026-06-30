/**
 * API Health check route.
 *
 * The backend name is injected by the bootstrap layer rather than read from
 * `process.env` directly — this guarantees the value reflects the store that
 * was actually instantiated, even if the env var was overridden after boot.
 *
 * Vector statistics are pulled live from the store on every request via
 * `listVectorModels()` so the response surfaces real counts instead of
 * placeholders.
 */

import { createRequire } from "node:module";
import { Hono } from "hono";
import type {
  DataStore,
  MediaStore,
  MediaStoreBackend,
  StoreBackend,
  VectorBackend,
} from "@covel/store";
import { describeStorageCapabilities } from "@covel/store";

const bootId = crypto.randomUUID();

/**
 * Running server version. Sourced from the @covel/server package.json so it
 * tracks releases automatically (a desktop shell may override via
 * COVEL_APP_VERSION). Falls back to "0.0.0" only if the manifest can't be read.
 */
const APP_VERSION: string =
  process.env.COVEL_APP_VERSION ??
  (() => {
    try {
      const require = createRequire(import.meta.url);
      return (
        (require("../../../package.json") as { version?: string }).version ??
        "0.0.0"
      );
    } catch {
      return "0.0.0";
    }
  })();

export function createHealthRoutes(
  store: DataStore,
  backend: StoreBackend,
  options: {
    readonly mediaBackend?: MediaStoreBackend;
    readonly mediaStore?: MediaStore;
    readonly vectorBackend?: VectorBackend;
  } = {},
): Hono {
  const app = new Hono();

  // GET /health — Health check
  app.get("/", async (c) => {
    const storage = await describeStorageCapabilities({
      dataBackend: backend,
      mediaBackend: options.mediaBackend,
      mediaStore: options.mediaStore,
      vectorBackend: options.vectorBackend,
      store,
    });

    return c.json({
      status: "ok",
      version: APP_VERSION,
      bootId,
      timestamp: new Date().toISOString(),
      storage,
      vector: storage.vector,
    });
  });

  return app;
}
