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
import { seedWorlds, reconcileSeededWorlds } from "./world-seed-loader.js";
import { createWorldFileWatcher } from "./world-file-watcher.js";
import { createModelDbRoutes } from "./routes/model-db.js";
import { createMiscApiRoutes } from "./routes/misc-api.js";
import { createConfigApiRoutes } from "./routes/config-api.js";
import { createPerRequestLlmMiddleware } from "./middleware/per-request-llm.js";
import { createRequestBodyLimitMiddleware } from "./middleware/request-body-limit.js";
import {
  errorBody,
  makeErrorHandler,
  redactSensitiveQueryParamsInText,
} from "./api-error.js";
import { parseEnvLines } from "./lib/env-file.js";
import { validateSecurityPosture } from "./security-posture.js";
import {
  providerApiKeysFromEnv,
  providerIdToApiKeyEnvName,
  readEnvInt,
  readRuntimeEnv,
} from "@covel/shared";
import type { Sql } from "postgres";

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
    for (const [key, val] of parseEnvLines(readFileSync(file, "utf-8"))) {
      const envKey = providerIdToApiKeyEnvName(key);
      if (envKey && target[envKey] === undefined) target[envKey] = val;
    }
  } catch (err) {
    console.warn(`[server] Could not read ${file}:`, err);
  }
}

/**
 * Base dir first, plus the user override dir only when set and distinct.
 * Shared by pluginsDirs and worldsDirs.
 */
function mergeDirs(base: string, user: string | undefined): string[] {
  return user && user !== base ? [base, user] : [base];
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

// Fail fast on an unsafe hosted posture (audit S-13) before any route is
// wired or the caller starts listening. No-op for self-deploy/desktop.
validateSecurityPosture(env);

// ── Global error handler ────────────────────────────────────────
const isDev = env.nodeEnv !== "production";
app.onError(makeErrorHandler("[server] Unhandled error", isDev));

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
const honoLogger = logger((message) =>
  console.log(redactSensitiveQueryParamsInText(message)),
);
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
// Hoisted so the shutdown drain below can close the lock pool.
let lockSql: Sql | undefined;
if (storeBackend === "pg" && env.databaseUrl) {
  const { default: postgres } = await import("postgres");
  // `max` sizes the lock pool. Each in-flight turn holds one reserved
  // connection for the duration of executeTurn; the default 16 is well above
  // the expected peak per pod and keeps PG connection usage bounded. Tune via
  // COVEL_PG_LOCK_POOL_MAX for higher-concurrency pods.
  lockSql = postgres(env.databaseUrl!, {
    max: readEnvInt("COVEL_PG_LOCK_POOL_MAX", 16),
  });
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
// Env-derived keys ride the `envApiKeys` channel so the provider registry
// origin-gates them (S-01) — the startup paths never carry request-scoped
// slot overlays today, but the provenance stays honest if that changes.
const llmAdapter = createGatewayAdapter(ai.gateway, { envApiKeys: apiKeys });
// Function-runtime gateway facade — shares the same preset/provider
// registry and env apiKeys as the agent-runtime LLM adapter. Plugins
// that need generateImage / generateText / generateObject reach it via
// `FunctionHandlerContext.gateway`. `toZodSchema` is left off at
// startup: the framework's agent runtimes already cover structured
// output via responseFormat, and plugin-data calls use tool schemas —
// exposing `generateObject` would require importing zod into the
// app.ts composition root. A future PR can supply a converter if a
// plugin genuinely needs it.
const pluginGateway = createPluginRuntimeGateway(ai.gateway, {
  envApiKeys: apiKeys,
});
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
const pluginsDirs = mergeDirs(bundledPluginsDir, env.userPluginsDir);
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
    apiKeys ? { envApiKeys: apiKeys } : undefined,
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
const worldsDirs = mergeDirs(bundledWorldsDir, env.userWorldsDir);

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

const seededWorldIds = new Set<string>();
for (const dir of worldsDirs) {
  try {
    for (const id of await seedWorlds(store, dir)) seededWorldIds.add(id);
  } catch (err) {
    console.warn(`[server] Could not seed worlds from ${dir}:`, err);
  }
}

// Drop DB worlds that were file-seeded from a now-removed package (e.g. an
// archived sample world) so they stop appearing in every existing user's world
// list. Skip entirely when nothing seeded — a transient load failure must not
// wipe worlds — and keep any stale world that still has saved sessions.
if (seededWorldIds.size === 0) {
  console.warn(
    "[world-seed] No worlds seeded — skipping reconciliation to avoid removing worlds on a load failure.",
  );
} else {
  try {
    const { removed, keptWithSessions } = await reconcileSeededWorlds(
      store,
      seededWorldIds,
    );
    if (removed.length > 0) {
      console.log(
        `[world-seed] Reconciled — removed ${removed.length} stale file-seeded world(s) no longer in any package: ${removed.join(", ")}`,
      );
    }
    if (keptWithSessions.length > 0) {
      console.warn(
        `[world-seed] ${keptWithSessions.length} world(s) removed from packages still have saved sessions and were kept: ${keptWithSessions.join(", ")}. Delete them explicitly to clear.`,
      );
    }
  } catch (err) {
    console.warn("[server] World reconciliation failed:", err);
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

// ── Graceful shutdown drain (audit R-11) ─────────────────────────
// Ordered resource drain passed to registerGracefulShutdown() by index.ts and
// run after the HTTP server stops accepting requests: stop watchers (no new
// world reloads), flush pending eventBus persistence, then close the DataStore
// and the dedicated PG lock pool. Each phase is time-boxed so one stuck
// resource cannot eat the whole force-exit budget — a timed-out phase is
// logged and skipped.
const DRAIN_PHASE_TIMEOUT_MS = 2_000;

async function drainPhase(
  name: string,
  run: () => Promise<unknown> | void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${DRAIN_PHASE_TIMEOUT_MS}ms`)),
      DRAIN_PHASE_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([Promise.resolve(run()), timeout]);
  } catch (err) {
    console.warn(
      `[shutdown] drain phase "${name}" failed:`,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

export const drainServerResources = async (): Promise<void> => {
  await drainPhase("stop world watchers", () => stopWatchers());
  await drainPhase("flush event bus", () => api.eventBus.flush());
  await drainPhase("close data store", () => store.close());
  if (lockSql) {
    // `timeout: 1` (seconds) force-closes connections still held by an
    // in-flight lock; PG auto-releases advisory locks on disconnect.
    await drainPhase("close pg lock pool", () => lockSql!.end({ timeout: 1 }));
  }
};

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
