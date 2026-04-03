import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { healthRoute } from "./routes/health.js";
import { apiKeyInjection } from "./middleware/api-key-injection.js";
import { createAiStack } from "./ai-setup.js";
import { createGenerateRoute } from "./routes/ai/generate.js";
import { createStreamRoute } from "./routes/ai/stream.js";
import { createPingRoute } from "./routes/ai/ping.js";
import { createPresetsRoute } from "./routes/config/presets.js";
import { createTurnRoute } from "./routes/kernel/turn.js";
import { createPluginsRoute } from "./routes/plugins/list.js";
import { createBlockSchemasRoute } from "./routes/plugins/block-schemas.js";
import { createCommandsListRoute } from "./routes/commands/list.js";
import { createCommandExecuteRoute } from "./routes/commands/execute.js";
import { createWorldsRoute } from "./routes/worlds.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { createActionsRoute } from "./routes/actions.js";
import { createCompatPackagesRoute } from "./routes/compat/packages.js";
import { createCompatPresetsRoute } from "./routes/compat/presets.js";
import { createCompatCommandsRoute } from "./routes/compat/commands.js";
import { createCharactersRoute } from "./routes/characters.js";
import { createSessionPluginsRoute } from "./routes/session-plugins.js";
import { initKernelStack } from "./kernel-setup.js";
import { createMemoryStore } from "./store/memory-store.js";
import { createPgServerStore } from "./store/pg-server-store.js";

const app = new Hono();

app.use("*", logger());
if (process.env.DEPLOYMENT_TIER && process.env.DEPLOYMENT_TIER !== "self") {
  app.use("*", secureHeaders());
}
app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
      : ["http://localhost:5173"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  }),
);

// API key injection for routes that need LLM access
app.use("/api/ai/*", apiKeyInjection);
app.use("/api/kernel/*", apiKeyInjection);
app.use("/actions", apiKeyInjection);

// Initialize stacks
const ai = createAiStack();
const kernelStack = await initKernelStack(ai.gateway);

// Store backend: use PG when DATABASE_URL is set and STORE_BACKEND=pg
const storeBackend = process.env.STORE_BACKEND ?? "memory";
const store = storeBackend === "pg" && process.env.DATABASE_URL
  ? await createPgServerStore({ databaseUrl: process.env.DATABASE_URL })
  : await createMemoryStore();

// ── Internal API routes (programmatic access) ────────────────────
app.route("/api/health", healthRoute);
app.route("/api/ai/generate", createGenerateRoute(ai));
app.route("/api/ai/stream", createStreamRoute(ai));
app.route("/api/ai/ping", createPingRoute(ai));
app.route("/api/config/presets", createPresetsRoute(ai));
// DEBUG-ONLY: Uses default kernel session — not suitable for multi-session production use.
app.route("/api/kernel/turn", createTurnRoute(kernelStack.kernel));
app.route("/api/plugins", createPluginsRoute(kernelStack.pluginHost));
app.route("/api/block-schemas", createBlockSchemasRoute(kernelStack.pluginHost));
app.route("/api/commands", createCommandsListRoute(kernelStack.pluginHost.commandRegistry));
app.route("/api/commands/execute", createCommandExecuteRoute(kernelStack.commandBus));

// ── Frontend-compatible routes (match what apps/web expects) ─────
app.route("/worlds", createWorldsRoute(store));
app.route("/sessions", createSessionsRoute(store));
app.route("/actions", createActionsRoute({
  getOrCreateSession: (sessionId) => kernelStack.getOrCreateSession(sessionId),
  commandBus: kernelStack.commandBus,
  store,
  presetRegistry: ai.presetRegistry,
}));
app.route("/characters", createCharactersRoute(store));
app.route("/sessions", createSessionPluginsRoute({
  pluginHost: kernelStack.pluginHost,
  getOrCreateSession: (sessionId) => kernelStack.getOrCreateSession(sessionId),
}));
app.route("/commands", createCompatCommandsRoute(kernelStack.pluginHost.commandRegistry));
app.route("/packages", createCompatPackagesRoute(kernelStack.pluginHost));
app.route("/presets", createCompatPresetsRoute(ai));

app.route("/block-schemas", createBlockSchemasRoute(kernelStack.pluginHost));

// Expose server-configured provider keys to frontend for auto-fill.
// Only available when DEPLOYMENT_TIER=self or ENABLE_DEV_KEYS_ENDPOINT=true.
import { createDevKeysRoute } from "./routes/dev-keys.js";
const deploymentTier = process.env.DEPLOYMENT_TIER ?? "self";
if (deploymentTier === "self" || process.env.ENABLE_DEV_KEYS_ENDPOINT === "true") {
  app.route("/api/provider-keys", createDevKeysRoute(ai.llmConfig));
}

// Expose llm.toml slot configuration to frontend (with capability data).
import { createLlmConfigRoute } from "./routes/llm-config.js";
app.route("/api/llm-config", createLlmConfigRoute(ai.llmConfig, ai.presetRegistry.listPresets()));

// Model database API (search, lookup, refresh from GitHub).
import { createModelDbRoute } from "./routes/model-db.js";
app.route("/api/model-db", createModelDbRoute(ai.modelDb));

// Health check at root too
app.route("/health", healthRoute);

// Trace event inspection API
import { createTracesRoute } from "./routes/traces.js";
app.route("/api/traces", createTracesRoute(store));

// Stubs for legacy endpoints
app.get("/archives", (c) => c.json([]));

// ── Static file serving (production) ───────────────────────────────
// Serve the built web frontend from /app/web-dist when SERVE_STATIC is set
if (process.env.SERVE_STATIC === "true") {
  const root = process.env.STATIC_DIR ?? "./web-dist";
  app.use("/*", serveStatic({ root }));
  // SPA fallback: serve index.html for non-API routes
  app.get("*", serveStatic({ root, path: "/index.html" }));
}

export { app };
