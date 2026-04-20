/**
 * Covel Server — Hono application entry point.
 *
 * Composition root: middleware → init → mount routes.
 * Route logic lives in routes/ modules.
 */

import { resolve, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
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
import { createConfigApiRoutes } from "./routes/config-api.js";

/**
 * Merge `~/.covel/keys.env` (or `$COVEL_HOME/keys.env` when overridden)
 * into `target`. Existing entries are NOT overwritten — process.env and
 * shell-injected env take precedence over the static file, so a user can
 * still override a persisted key via `DEEPSEEK_API_KEY=... pnpm dev`.
 * Missing file is fine.
 */
function loadKeysEnvInto(target: NodeJS.ProcessEnv): void {
  const home = process.env.COVEL_HOME ?? join(homedir(), ".covel");
  const file = join(home, "keys.env");
  if (!existsSync(file)) return;
  try {
    for (const raw of readFileSync(file, "utf-8").split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && target[key] === undefined) target[key] = val;
    }
  } catch (err) {
    console.warn(`[server] Could not read ${file}:`, err);
  }
}

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

// Guard any /api/debug/* or /api/internal/* route in production so that an
// accidentally-mounted diagnostic endpoint can never leak in a released
// build. ENABLE_DEBUG_PAGE=1 opts in (e.g. for self-hosted tiers).
const allowDebugRoutes =
  isDev || process.env.ENABLE_DEBUG_PAGE === "1" || process.env.ENABLE_DEBUG_PAGE === "true";
if (!allowDebugRoutes) {
  app.all("/api/debug/*", (c) => c.json({ error: "Not available" }, 403));
  app.all("/api/internal/*", (c) => c.json({ error: "Not available" }, 403));
}
// CORS — default whitelist covers:
//   - dev Vite server at localhost:5173 / 127.0.0.1:5173
//   - Electron desktop shell (file:// renders) and arbitrary loopback ports
//     used by the sidecar server. The Electron preload pins 127.0.0.1, so we
//     allow any 127.0.0.1:port for loopback navigation.
const defaultAllowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];
const isLoopbackOrigin = (origin: string): boolean =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      const configured = process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
        : defaultAllowedOrigins;
      if (configured.includes(origin)) return origin;
      if (isLoopbackOrigin(origin)) return origin;
      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  }),
);

// ── Initialize AI + Store ────────────────────────────────────────
const ai = createAiStack();
const storeBackend = resolveBackendFromEnv();
const store = await createStoreFromEnv();

// Merge ~/.covel/keys.env (plain KEY=VALUE lines) into process.env. The
// desktop shells already pre-merge this into the child env, but running
// the server directly (pnpm dev:server, CI) benefits from the same source
// of truth without having to juggle .env.llm separately.
loadKeysEnvInto(process.env);

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
// Bundled plugins ship inside the repo / packaged app. The desktop shell
// can additionally mount a user plugins directory via COVEL_USER_PLUGINS_DIR
// (typically `<userData>/plugins`). Bundled wins on id collision so user
// plugins can augment but not shadow core functionality.
const bundledPluginsDir =
  process.env.COVEL_PLUGINS_DIR ??
  resolve(import.meta.dirname, "../../../plugins");
const userPluginsDir = process.env.COVEL_USER_PLUGINS_DIR;
const pluginsDirs = [bundledPluginsDir];
if (userPluginsDir && userPluginsDir !== bundledPluginsDir) {
  pluginsDirs.push(userPluginsDir);
}
const ensureEmbeddingLock = createEmbeddingLockHelper({ store, ai, apiKeys });
const api = await bootstrapApi({
  pluginsDir: bundledPluginsDir,
  pluginsDirs,
  llmAdapter,
  store,
  storeBackend,
  ensureEmbeddingLock,
});

// ── Seed worlds ──────────────────────────────────────────────────
// Bundled worlds are always seeded. When COVEL_USER_WORLDS_DIR is set
// (desktop app points it at userData/worlds), user-created worlds are
// merged on top and hot-reloaded alongside.
const bundledWorldsDir =
  process.env.COVEL_WORLDS_DIR ??
  resolve(import.meta.dirname, "../../../worlds");
const userWorldsDir = process.env.COVEL_USER_WORLDS_DIR;
const worldsDirs = [bundledWorldsDir];
if (userWorldsDir && userWorldsDir !== bundledWorldsDir) {
  worldsDirs.push(userWorldsDir);
}

for (const dir of worldsDirs) {
  try {
    await seedWorlds(store, dir);
  } catch (err) {
    console.warn(`[server] Could not seed worlds from ${dir}:`, err);
  }
}

// ── World file watcher (hot-reload) ─────────────────────────────
const worldWatchers = worldsDirs.map((dir) =>
  createWorldFileWatcher(dir, store, api.eventBus),
);
for (const watcher of worldWatchers) watcher.start();
const stopWatchers = () => {
  for (const watcher of worldWatchers) watcher.stop();
};
process.on("SIGTERM", stopWatchers);
process.on("SIGINT", stopWatchers);

// ── Mount routes ─────────────────────────────────────────────────
app.route("/", api.app);
app.route("/", createModelDbRoutes(ai));
app.route("/", createMiscApiRoutes(ai, api.registry, store));
app.route("/", createConfigApiRoutes({ apiKeys }));

// ── Static file serving (production) ─────────────────────────────
if (process.env.SERVE_STATIC === "true") {
  const root = process.env.STATIC_DIR ?? "./web-dist";
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "/index.html" }));
}

export { app };
