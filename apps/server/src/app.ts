/**
 * Covel Server — Hono application entry point.
 *
 * Composition root: middleware → init → mount routes.
 * Route logic lives in routes/ modules.
 */

import { resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { createAiStack } from "./ai-setup.js";
import { createStoreFromEnv, resolveBackendFromEnv } from "@covel/store";
import { createEmbeddingLockHelper } from "./embedding-lock.js";
import { createGatewayAdapter } from "@covel/runtime";
import { bootstrapApi } from "./routes/api/bootstrap.js";
import { seedWorlds } from "./world-seed-loader.js";
import { createWorldFileWatcher } from "./world-file-watcher.js";
import { createModelDbRoutes } from "./routes/model-db.js";
import { createMiscApiRoutes } from "./routes/misc-api.js";

const app = new Hono();

// ── Global error handler ────────────────────────────────────────
const isDev = process.env.NODE_ENV !== "production";
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[server] Unhandled error:`, err);
  return c.json({ error: isDev ? message : "Internal server error" }, 500);
});

// ── Middleware ────────────────────────────────────────────────────
app.use("*", logger());
app.use("*", secureHeaders());
app.use("*", bodyLimit({ maxSize: 1 * 1024 * 1024 }));
app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
      : ["http://localhost:5173"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  }),
);

// ── Initialize AI + Store ────────────────────────────────────────
const ai = createAiStack();
const storeBackend = resolveBackendFromEnv();
const store = await createStoreFromEnv();

// Collect all *_API_KEY env vars dynamically so any provider can be added
// to llm.toml without requiring code changes here.
const apiKeys: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.endsWith("_API_KEY") && value) {
    const provider = key.slice(0, -8).toLowerCase(); // strip "_API_KEY" suffix
    apiKeys[provider] = value;
  }
}
const llmAdapter = createGatewayAdapter(ai.gateway, { apiKeys });

// ── Bootstrap API ───────────────────────────────────────────────
const pluginsDir =
  process.env.COVEL_PLUGINS_DIR ??
  resolve(import.meta.dirname, "../../../plugins");
const ensureEmbeddingLock = createEmbeddingLockHelper({ store, ai, apiKeys });
const api = await bootstrapApi({
  pluginsDir,
  llmAdapter,
  store,
  storeBackend,
  ensureEmbeddingLock,
});

// ── Seed worlds ──────────────────────────────────────────────────
const worldsDir =
  process.env.COVEL_WORLDS_DIR ??
  resolve(import.meta.dirname, "../../../worlds");
await seedWorlds(store, worldsDir);

// ── World file watcher (hot-reload) ─────────────────────────────
const worldWatcher = createWorldFileWatcher(worldsDir, store, api.eventBus);
worldWatcher.start();
process.on("SIGTERM", () => worldWatcher.stop());
process.on("SIGINT", () => worldWatcher.stop());

// ── Mount routes ─────────────────────────────────────────────────
app.route("/", api.app);
app.route("/", createModelDbRoutes(ai));
app.route("/", createMiscApiRoutes(ai, api.registry, store));

// ── Static file serving (production) ─────────────────────────────
if (process.env.SERVE_STATIC === "true") {
  const root = process.env.STATIC_DIR ?? "./web-dist";
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "/index.html" }));
}

export { app };
