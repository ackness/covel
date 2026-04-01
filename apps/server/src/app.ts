import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { healthRoute } from "./routes/health.js";
import { apiKeyInjection } from "./middleware/api-key-injection.js";
import { createAiStack } from "./ai-setup.js";
import { createGenerateRoute } from "./routes/ai/generate.js";
import { createStreamRoute } from "./routes/ai/stream.js";
import { createPresetsRoute } from "./routes/config/presets.js";
import { createTurnRoute } from "./routes/kernel/turn.js";
import { createPluginsRoute } from "./routes/plugins/list.js";
import { createCommandsListRoute } from "./routes/commands/list.js";
import { createCommandExecuteRoute } from "./routes/commands/execute.js";
import { createWorldsRoute } from "./routes/worlds.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { createActionsRoute } from "./routes/actions.js";
import { createCompatPackagesRoute } from "./routes/compat/packages.js";
import { createCompatPresetsRoute } from "./routes/compat/presets.js";
import { createCompatCommandsRoute } from "./routes/compat/commands.js";
import { initKernelStack } from "./kernel-setup.js";
import { createMemoryStore } from "./store/memory-store.js";

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ["http://localhost:5173"],
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
const store = createMemoryStore();

// ── Internal API routes (programmatic access) ────────────────────
app.route("/api/health", healthRoute);
app.route("/api/ai/generate", createGenerateRoute(ai));
app.route("/api/ai/stream", createStreamRoute(ai));
app.route("/api/config/presets", createPresetsRoute(ai));
app.route("/api/kernel/turn", createTurnRoute(kernelStack.kernel));
app.route("/api/plugins", createPluginsRoute(kernelStack.pluginHost));
app.route("/api/commands", createCommandsListRoute(kernelStack.pluginHost.commandRegistry));
app.route("/api/commands/execute", createCommandExecuteRoute(kernelStack.commandBus));

// ── Frontend-compatible routes (match what apps/web expects) ─────
app.route("/worlds", createWorldsRoute(store));
app.route("/sessions", createSessionsRoute(store));
app.route("/actions", createActionsRoute({
  kernel: kernelStack.kernel,
  commandBus: kernelStack.commandBus,
  store,
}));
app.route("/commands", createCompatCommandsRoute(kernelStack.pluginHost.commandRegistry));
app.route("/packages", createCompatPackagesRoute(kernelStack.pluginHost));
app.route("/presets", createCompatPresetsRoute(ai));

// Health check at root too
app.route("/health", healthRoute);

// Stubs for endpoints the frontend may call
app.get("/traces", (c) => c.json([]));
app.get("/archives", (c) => c.json([]));

export { app };
