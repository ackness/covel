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
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { createAiStack } from "./ai-setup.js";
import {
  createMediaStoreFromEnv,
  createStoreFromEnv,
  resolveBackendFromEnv,
} from "@covel/store";
import { createEmbeddingLockHelper } from "./embedding-lock.js";
import {
  createGatewayAdapter,
  createPluginRuntimeGateway,
} from "@covel/runtime";
import { fetchWithRetry, validateBaseUrlForPlugin } from "@covel/ai-provider";
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
import { createRequestBodyLimitMiddleware } from "./middleware/request-body-limit.js";
import { errorBody } from "./api-error.js";
import {
  providerApiKeysFromEnv,
  providerIdToApiKeyEnvName,
  readRuntimeEnv,
} from "@covel/shared";

/**
 * Merge `~/.covel/keys.env` (or `$COVEL_HOME/keys.env` when overridden)
 * into `target`. Existing entries are NOT overwritten — process.env and
 * shell-injected env take precedence over the static file, so a user can
 * still override a persisted key via `DEEPSEEK_API_KEY=... pnpm dev`.
 * Missing file is fine.
 */
function loadKeysEnvInto(target: NodeJS.ProcessEnv): void {
  const home = readRuntimeEnv(target).covelHome ?? join(homedir(), ".covel");
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
const env = readRuntimeEnv();

// ── Global error handler ────────────────────────────────────────
const isDev = env.nodeEnv !== "production";
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[server] Unhandled error:`, err);
  return c.json(errorBody(isDev ? message : "Internal server error"), 500);
});

// ── Middleware ────────────────────────────────────────────────────
// Suppress Hono request logging for noisy paths (Electron heartbeat, health
// probes). These routes are hit ~1×/s and would otherwise dwarf every other
// signal in `server.log`. Override via COVEL_LOG_QUIET_PATHS (comma-separated).
const QUIET_LOG_PATHS = new Set<string>(
  (process.env.COVEL_LOG_QUIET_PATHS ?? "/api/health")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0),
);
const honoLogger = logger();
app.use("*", async (c, next) => {
  if (QUIET_LOG_PATHS.has(c.req.path)) return next();
  return honoLogger(c, next);
});
app.use("*", secureHeaders());
app.use("*", createRequestBodyLimitMiddleware());

// Guard any /api/debug/* or /api/internal/* route in production so that an
// accidentally-mounted diagnostic endpoint can never leak in a released
// build. ENABLE_DEBUG_PAGE=1 opts in (e.g. for self-hosted tiers).
const allowDebugRoutes = isDev || env.debugRoutes;
if (!allowDebugRoutes) {
  app.all("/api/debug/*", (c) => c.json(errorBody("Not available"), 403));
  app.all("/api/internal/*", (c) => c.json(errorBody("Not available"), 403));
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
// Sidecar's own port. Electron renderer loads from `http://127.0.0.1:<port>/`
// in production, so we must always allow same-origin requests there even
// when the user pinned `CORS_ORIGIN` to a single domain.
const sidecarOrigins = [
  `http://localhost:${env.serverPort}`,
  `http://127.0.0.1:${env.serverPort}`,
];
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      const configured =
        env.corsOrigins.length > 0 ? env.corsOrigins : defaultAllowedOrigins;
      if (configured.includes(origin)) return origin;
      if (sidecarOrigins.includes(origin)) return origin;
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
const mediaStore = await createMediaStoreFromEnv(process.env);

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
if (storeBackend === "pg" && env.databaseUrl) {
  const { default: postgres } = await import("postgres");
  // `max` sizes the lock pool. Each in-flight turn holds one reserved
  // connection for the duration of executeTurn; 16 is well above the
  // expected peak per pod and keeps PG connection usage bounded.
  const lockSql = postgres(env.databaseUrl!, { max: 16 });
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
const apiKeys = providerApiKeysFromEnv(process.env);
const llmAdapter = createGatewayAdapter(ai.gateway, { apiKeys });
// Function-runtime gateway facade — shares the same preset/provider
// registry and env apiKeys as the agent-runtime LLM adapter. Plugins
// that need generateImage / generateText / generateObject reach it via
// `FunctionHandlerContext.gateway`. `toZodSchema` is left off at
// startup: the framework's agent runtimes already cover structured
// output via responseFormat, and plugin-data calls use tool schemas —
// exposing `generateObject` would require importing zod into the
// app.ts composition root. A future PR can supply a converter if a
// plugin genuinely needs it.
const pluginGateway = createPluginRuntimeGateway(ai.gateway, { apiKeys });
// Stateless plugin utility surface — exposed to function handlers via
// `FunctionHandlerContext.utils`. Plugins call these in lieu of bare
// fetch / hand-rolled SSRF checks so the framework stays the single
// source of truth for those policies.
const pluginUtils = {
  validateBaseUrl: validateBaseUrlForPlugin,
  fetchWithRetry,
};
const preferredMemorySlot = resolvePreferredMemorySlot(ai.slotRegistry);

// ── Bootstrap API ───────────────────────────────────────────────
// Bundled plugins ship inside the repo / packaged app. The desktop shell
// can additionally mount a user plugins directory via COVEL_USER_PLUGINS_DIR
// (typically `<userData>/plugins`). Bundled wins on id collision so user
// plugins can augment but not shadow core functionality.
const bundledPluginsDir =
  env.pluginsDir ?? resolve(import.meta.dirname, "../../../plugins");
const userPluginsDir = env.userPluginsDir;
const pluginsDirs = [bundledPluginsDir];
if (userPluginsDir && userPluginsDir !== bundledPluginsDir) {
  pluginsDirs.push(userPluginsDir);
}
const ensureEmbeddingLock = createEmbeddingLockHelper({ store, ai, apiKeys });
// Embedding seam for the semantic memory tier. The memory package never
// imports a provider — it gets this injected (mirrors the LLM adapter). Routes
// through the same gateway embed slot the embedding-lock probe uses, so the
// produced dimension always matches the session's locked vector model.
const memoryEmbed = async (
  texts: readonly string[],
): Promise<Float32Array[]> => {
  const res = await ai.gateway.embed(
    { values: [...texts] },
    apiKeys ? { apiKeys } : undefined,
  );
  return res.embeddings.map((e) => Float32Array.from(e));
};
const perRequestLlm = createPerRequestLlmMiddleware({
  ai,
  envApiKeys: apiKeys,
  defaultLlmAdapter: llmAdapter,
  defaultPluginGateway: pluginGateway,
});
// ── Seed worlds ──────────────────────────────────────────────────
// Bundled worlds are always seeded. When COVEL_USER_WORLDS_DIR is set
// (desktop app points it at userData/worlds), user-created worlds are
// merged on top and hot-reloaded alongside.
const bundledWorldsDir =
  env.worldsDir ?? resolve(import.meta.dirname, "../../../worlds");
const userWorldsDir = env.userWorldsDir;
const worldsDirs = [bundledWorldsDir];
if (userWorldsDir && userWorldsDir !== bundledWorldsDir) {
  worldsDirs.push(userWorldsDir);
}

const api = await bootstrapApi({
  pluginsDir: bundledPluginsDir,
  pluginsDirs,
  worldsDirs,
  covelHome: env.covelHome,
  llmAdapter,
  pluginGateway,
  pluginUtils,
  store,
  storeBackend,
  mediaStore,
  mediaBackend: env.mediaBackend,
  vectorBackend: env.vectorBackend,
  ensureEmbeddingLock,
  memoryEmbed,
  preferredMemorySlot,
  perRequestMiddleware: [perRequestLlm],
  sessionLock,
});

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
if (env.serveStatic) {
  const root = env.staticDir;
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "/index.html" }));
}

export { app };
