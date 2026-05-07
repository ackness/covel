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

import { Hono } from "hono";
import type { DataStore, StoreBackend } from "@covel/store";
import { supportsVector } from "@covel/store";

const bootId = crypto.randomUUID();

function getVectorDriver(backend: StoreBackend): string {
  switch (backend) {
    case "sqlite":
      return "sqlite-vec";
    case "pg":
      return "pgvector";
    case "memory":
      return "in-memory";
    default:
      return "none";
  }
}

export function createHealthRoutes(
  store: DataStore,
  backend: StoreBackend,
): Hono {
  const app = new Hono();

  // GET /health — Health check
  app.get("/", async (c) => {
    const capable = supportsVector(store);
    const driver = getVectorDriver(backend);

    let modelCount = 0;
    let tableCount = 0;
    if (capable) {
      try {
        const models = await store.listVectorModels();
        modelCount = models.length;
        // Each model owns exactly one physical table.
        tableCount = models.length;
      } catch (err) {
        // Don't let observability break the health endpoint.
        // eslint-disable-next-line no-console
        console.warn(
          `[health] listVectorModels failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return c.json({
      status: "ok",
      version: "1.0.0",
      storeBackend: backend,
      bootId,
      timestamp: new Date().toISOString(),
      vector: {
        capable,
        driver,
        modelCount,
        tableCount,
      },
    });
  });

  return app;
}
