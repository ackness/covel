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
import {
  createInProcessSessionLock,
  type SessionLock,
} from "./lib/session-lock.js";
import { createPgAdvisorySessionLock } from "./lib/pg-session-lock.js";
import { seedWorlds } from "./world-seed-loader.js";
import { createWorldFileWatcher } from "./world-file-watcher.js";
import { createModelDbRoutes } from "./routes/model-db.js";
import { createMiscApiRoutes } from "./routes/misc-api.js";
import { createConfigApiRoutes } from "./routes/config-api.js";
import { createPerRequestLlmMiddleware } from "./middleware/per-request-llm.js";
import { apiKeyEnvNameToProviderId, providerIdToApiKeyEnvName } from "@covel/shared";

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
      const envKey = providerIdToApiKeyEnvName(key);
      if (envKey && target[envKey] === undefined) target[envKey] = val;
    }
  } catch (err) {
    console.warn(`[server] Could not read ${file}:`, err);
  }
}

function resolvePreferredMemorySlot(slotRegistry: {
  resolveSlot(slotId: string): string | undefined;
  listSlotsByTag(tag: string): Array<{ slotId: string }>;
}): string {
  for (const candidate of ["memory", "plugin", "story"] as const) {
    if (slotRegistry.resolveSlot(candidate)) return candidate;
  }
  return slotRegistry.listSlotsByTag("text")[0]?.slotId ?? "plugin";
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

// Merge ~/.covel/keys.env (plain KEY=VALUE lines) into process.env BEFORE
// createAiStack(). ai-setup reads llm.toml which does `${ENV}`
// interpolation — if keys.env loaded after, a slot spec like
// `apiKey = "${DEEPSEEK_API_KEY}"` sees `undefined` and silently falls
// back to the built-in default. Desktop shells already pre-merge this
// into the child env; this keeps parity for `pnpm dev:server` / CI /
// docker where the server is spawned directly.
loadKeysEnvInto(process.env);

// ── Initialize AI + Store ────────────────────────────────────────
const ai = createAiStack();
const storeBackend = resolveBackendFromEnv();
const store = await createStoreFromEnv();

// ── Session lock ────────────────────────────────────────────────
//
// PG deployments need cross-pod mutual exclusion per sessionId; the
// in-process `Map`-based lock only serialises within one Node process.
// We open a separate small postgres.js client dedicated to advisory
// locks so long-held lock connections never starve the data path.
//
// For memory/sqlite or when DATABASE_URL is missing we fall through to
// the in-process implementation — those topologies are single-process
// by construction, so the simpler lock is both sufficient and cheaper.
let sessionLock: SessionLock;
if (storeBackend === "pg" && process.env.DATABASE_URL) {
  const { default: postgres } = await import("postgres");
  // `max` sizes the lock pool. Each in-flight turn holds one reserved
  // connection for the duration of executeTurn; 16 is well above the
  // expected peak per pod and keeps PG connection usage bounded.
  const lockSql = postgres(process.env.DATABASE_URL, { max: 16 });
  sessionLock = createPgAdvisorySessionLock(lockSql);
  console.log(
    "[server] session lock: pg-advisory (cross-pod mutual exclusion enabled)",
  );
} else {
  sessionLock = createInProcessSessionLock();
  console.log(
    `[server] session lock: in-process (${storeBackend} backend — single-process scope)`,
  );
}

// Collect all *_API_KEY env vars dynamically so any provider can be added
// to llm.toml without requiring code changes here.
const apiKeys: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  const provider = apiKeyEnvNameToProviderId(key);
  if (provider && value) {
    apiKeys[provider] = value;
  }
}
const llmAdapter = createGatewayAdapter(ai.gateway, { apiKeys });
const preferredMemorySlot = resolvePreferredMemorySlot(ai.slotRegistry);

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
const perRequestLlm = createPerRequestLlmMiddleware({
  ai,
  envApiKeys: apiKeys,
  defaultLlmAdapter: llmAdapter,
});
const api = await bootstrapApi({
  pluginsDir: bundledPluginsDir,
  pluginsDirs,
  llmAdapter,
  store,
  storeBackend,
  ensureEmbeddingLock,
  preferredMemorySlot,
  perRequestMiddleware: [perRequestLlm],
  sessionLock,
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
