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
} from "@covel/store/factory";
import { resolveUserResourceDirs } from "./lib/user-resource-dirs.js";
import {
  createEmbeddingLockHelper,
  createMemoryEmbed,
  createMemoryIndexControl,
} from "./embedding-lock.js";
import {
  createGatewayAdapter,
  createPluginRuntimeGateway,
} from "@covel/runtime";
import {
  configureProviderHostPolicy,
  fetchWithRetry,
  validateBaseUrlForPlugin,
} from "@covel/ai-provider";
import { setTranslationsDirectory } from "@covel/plugin-loader";
import { bootstrapApi } from "./routes/api/bootstrap.js";
import { hasServerRuntimeJobCredentials } from "./runtime-job-readiness.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "./lib/session-lock.js";
import { createPgAdvisorySessionLock } from "./lib/pg-session-lock.js";
import { applyPendingPackageUpdates } from "./routes/api/install/package-updates.js";
import { cleanupPackageStaging } from "./routes/api/install/package-staging.js";
import { recoverWorldPackageDeletions } from "./routes/api/worlds/file-package.js";
import { isWorldDeleting } from "./world-lifecycle.js";
import { seedAndReconcileWorlds } from "./world-seed-reconcile.js";
import { createWorldFileWatcher } from "./world-file-watcher.js";
import { mountApiRoutes } from "./host-routes.js";
import { createPerRequestLlmMiddleware } from "./middleware/per-request-llm.js";
import { createModelRelayRegistry } from "./model-relay/registry.js";
import { localModelRelayPagePolicy } from "./middleware/page-relay-policy.js";
import { createConsumeUnreadBodyMiddleware } from "./middleware/consume-unread-body.js";
import { createRequestBodyLimitMiddleware } from "./middleware/request-body-limit.js";
import { createOriginGuardMiddleware } from "./middleware/origin-guard.js";
import { createHostGuardMiddleware } from "./middleware/host-guard.js";
import { pluginFrameHeaders } from "./middleware/plugin-frame-headers.js";
import {
  errorBody,
  makeErrorHandler,
  redactSensitiveQueryParamsInText,
} from "./api-error.js";
import { hostProfileMiddleware, resolveHostProfile } from "./host-profile.js";
import {
  providerApiKeysFromEnv,
  parseProviderKeysEnv,
  toApiKeyEnvMap,
  readEnvInt,
  readRuntimeEnv,
} from "@covel/shared";
import type { Sql } from "postgres";
import {
  createServerResourceDrain,
  type ServerResources,
} from "./server-resources.js";
import { createApplicationWork } from "./application-work.js";

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
    const { keys } = parseProviderKeysEnv(readFileSync(file, "utf-8"));
    for (const [key, value] of Object.entries(toApiKeyEnvMap(keys))) {
      if (target[key] === undefined) target[key] = value;
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

const app = new Hono();
// An unknown DEPLOYMENT_TIER (or STORE_BACKEND, MEDIA_BACKEND, ...) throws
// here, which stops the start with the variable and its accepted values.
const env = readRuntimeEnv();

// The deployment form, decided once before any route is wired or the caller
// starts listening (host-profile.ts). It refuses a hosted tier without its
// secrets and settings the chosen form would silently ignore. Routes ask it
// through `hostProfileOf(c)`; the provider layer gets its part here.
export const hostProfile = resolveHostProfile(env, {
  storeBackend: resolveBackendFromEnv(),
});
configureProviderHostPolicy(hostProfile.credentials.provider);

const applicationWork = createApplicationWork();
app.use("*", hostProfileMiddleware(hostProfile));
app.use("*", applicationWork.middleware);
// Outermost after work ownership: a body an inner layer left unread is read
// before the response, so the keep-alive connection survives for the next request.
app.use("*", createConsumeUnreadBodyMiddleware());

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
/**
 * The local model relay's answer posts: a streamed model answer arrives as
 * many small posts, which would flood the log. The relay stream itself and
 * failures still show in the model call's own errors.
 */
const RELAY_ANSWER_PATH =
  /^\/api\/model-relay\/requests\/[^/]+\/(head|chunk|end)$/;
app.use("*", async (c, next) => {
  if (QUIET_LOG_PATHS.has(c.req.path) || RELAY_ANSWER_PATH.test(c.req.path))
    return next();
  return honoLogger(c, next);
});
app.use("*", secureHeaders());
// Before any route or static file: on the token-less self tier, a request
// must name this server by a loopback name or a COVEL_ALLOWED_HOSTS entry,
// which refuses DNS-rebound pages (see middleware/host-guard.ts).
app.use("*", createHostGuardMiddleware(hostProfile.network));
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
const isAllowedOrigin = (origin: string): boolean => {
  const configured =
    env.corsOrigins.length > 0 ? env.corsOrigins : defaultAllowedOrigins;
  return configured.includes(origin) || sidecarOrigins.includes(origin);
};
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      return isAllowedOrigin(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  }),
);
// CORS withholds the response; this withholds the write.
app.use("*", createOriginGuardMiddleware(isAllowedOrigin));

// Merge ~/.covel/keys.env (plain KEY=VALUE lines) into process.env BEFORE
// createAiStack(). ai-setup reads llm.toml which does `${ENV}`
// interpolation — if keys.env loaded after, a slot spec like
// `apiKey = "${DEEPSEEK_API_KEY}"` sees `undefined` and silently falls
// back to the built-in default. Capture external keys first so saved-key
// edits cannot remove or replace shell/.env credentials, even if equal.
const externalApiKeys = providerApiKeysFromEnv(process.env);
loadKeysEnvInto(process.env);

const resources: ServerResources = { applicationWork, worldWatchers: [] };
export const drainServerResources = createServerResourceDrain(resources);

async function initializeServer(): Promise<void> {
  try {
    // ── Initialize AI + Store ────────────────────────────────────────
    const ai = createAiStack();
    const storeBackend = resolveBackendFromEnv();
    const store = (resources.store = await createStoreFromEnv());
    const mediaStore = (resources.mediaStore = await createMediaStoreFromEnv(
      process.env,
    ));

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
    let memoryIngestLock: SessionLock;
    // Register each pool before another startup step can fail.
    let lockSql: Sql | undefined;
    let ingestLockSql: Sql | undefined;
    if (storeBackend === "pg" && env.databaseUrl) {
      const { default: postgres } = await import("postgres");
      // `max` sizes the lock pool. Each in-flight turn holds one reserved
      // connection for the duration of executeTurn; the default 16 is well above
      // the expected peak per pod and keeps PG connection usage bounded. Tune via
      // COVEL_PG_LOCK_POOL_MAX for higher-concurrency pods.
      lockSql = resources.lockSql = postgres(env.databaseUrl!, {
        max: readEnvInt("COVEL_PG_LOCK_POOL_MAX", 16),
      });
      sessionLock = createPgAdvisorySessionLock(lockSql);
      // Embedding sweeps hold their lock during provider I/O. Keep them on a
      // smaller independent pool so background work cannot starve player turns.
      ingestLockSql = resources.ingestLockSql = postgres(env.databaseUrl!, {
        max: readEnvInt("COVEL_PG_INGEST_LOCK_POOL_MAX", 4),
      });
      memoryIngestLock = createPgAdvisorySessionLock(ingestLockSql);
      console.log(
        "[server] session lock: pg-advisory (cross-pod mutual exclusion enabled)",
      );
    } else {
      sessionLock = createInProcessSessionLock();
      memoryIngestLock = createInProcessSessionLock();
      console.log(
        `[server] session lock: in-process (${storeBackend} backend — single-process scope)`,
      );
    }

    // Collect all *_API_KEY env vars dynamically so any provider can be added
    // to llm.toml without requiring code changes here.
    const apiKeys = providerApiKeysFromEnv(process.env);
    // Env-derived keys ride the `envApiKeys` channel so the provider registry
    // origin-gates them — the startup paths never carry request-scoped
    // slot overlays today, but the provenance stays honest if that changes.
    const llmAdapter = createGatewayAdapter(ai.gateway, {
      envApiKeys: apiKeys,
    });
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
    // ── Bootstrap API ───────────────────────────────────────────────
    // Bundled plugins ship inside the repo / packaged app. The desktop shell
    // can additionally mount a user plugins directory via COVEL_USER_PLUGINS_DIR
    // (typically `<userData>/plugins`). Bundled wins on id collision so user
    // plugins can augment but not shadow core functionality.
    const bundledPluginsDir =
      env.pluginsDir ?? resolve(import.meta.dirname, "../../../plugins");
    const userDirs = resolveUserResourceDirs(env);
    // Before update recovery, discovery, watchers, or routes can touch these files.
    await cleanupPackageStaging(userDirs.plugins);
    await cleanupPackageStaging(userDirs.worlds);
    await recoverWorldPackageDeletions(store, userDirs.worlds);
    const pluginsDirs = mergeDirs(bundledPluginsDir, userDirs.plugins);
    // Before any plugin loads: its labels and messages are read once.
    setTranslationsDirectory(userDirs.translations);
    const ensureEmbeddingLock = createEmbeddingLockHelper({
      store,
      ai,
      apiKeys,
    });
    const memoryEmbed = createMemoryEmbed({ ai, apiKeys });
    const memoryIndex = createMemoryIndexControl({ store, ai, apiKeys });
    // One relay registry per process: the browser's channel and the model
    // calls made for it meet here.
    const modelRelay = createModelRelayRegistry();
    const perRequestLlm = createPerRequestLlmMiddleware({
      ai,
      envApiKeys: apiKeys,
      defaultLlmAdapter: llmAdapter,
      defaultPluginGateway: pluginGateway,
      modelRelay,
    });
    // ── Seed worlds ──────────────────────────────────────────────────
    // User worlds use the same resolved directory as the install API, even
    // on a fresh installation where that directory does not exist yet.
    const bundledWorldsDir =
      env.worldsDir ?? resolve(import.meta.dirname, "../../../worlds");
    const worldsDirs = mergeDirs(bundledWorldsDir, userDirs.worlds);

    const api = (resources.api = await bootstrapApi({
      applicationWork,
      pluginsDir: bundledPluginsDir,
      pluginsDirs,
      worldsDirs,
      covelHome: env.covelHome,
      llmAdapter,
      canRunRuntimeJobWithServerServices: ({ model }) =>
        hasServerRuntimeJobCredentials(ai.gateway, model, apiKeys),
      pluginGateway,
      pluginUtils,
      store,
      storeBackend,
      hostProfile,
      mediaStore,
      mediaBackend: env.mediaBackend,
      vectorBackend: env.vectorBackend,
      ensureEmbeddingLock,
      memoryIndex,
      memoryEmbed,
      perRequestMiddleware: [perRequestLlm],
      sessionLock,
      memoryIngestLock,
    }));

    await applyPendingPackageUpdates(userDirs.worlds, async (id) => {
      const world = await store.getWorld(id);
      if (world && (world.metadata?.packageModified || isWorldDeleting(world)))
        throw new Error(
          "World was edited or is being deleted; queued update was not applied",
        );
    });
    await seedAndReconcileWorlds(store, worldsDirs, sessionLock);

    // ── World file watcher (hot-reload) ─────────────────────────────
    for (const dir of worldsDirs) {
      const watcher = createWorldFileWatcher(
        dir,
        store,
        api.eventBus,
        sessionLock,
        worldsDirs,
      );
      resources.worldWatchers.push(watcher);
      watcher.start();
    }

    // ── Mount routes ─────────────────────────────────────────────────
    mountApiRoutes(app, {
      api,
      ai,
      store,
      apiKeys,
      externalApiKeys,
      modelRelay,
    });

    // ── Static file serving (production) ─────────────────────────────
    if (env.serveStatic) {
      const root = env.staticDir;
      app.use("/*", pluginFrameHeaders());
      // The local model relay's connect sources, on shared hosts only.
      app.use(
        "/*",
        localModelRelayPagePolicy(hostProfile.credentials.modelRelay),
      );
      app.use("/*", serveStatic({ root }));
      app.get("*", serveStatic({ root, path: "/index.html" }));
    }
  } catch (error) {
    await drainServerResources();
    throw error;
  }
}

await initializeServer();

export { app };
