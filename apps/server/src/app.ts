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
import { initKernelStack } from "./kernel-setup.js";

const app = new Hono();

app.use("*", logger());
app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:5173"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  }),
);

// API key injection for AI and kernel routes
app.use("/api/ai/*", apiKeyInjection);
app.use("/api/kernel/*", apiKeyInjection);

// Initialize AI stack
const ai = createAiStack();

// Initialize kernel stack (plugins + kernel)
const kernelStack = await initKernelStack(ai.gateway);

// Routes
app.route("/api/health", healthRoute);
app.route("/api/ai/generate", createGenerateRoute(ai));
app.route("/api/ai/stream", createStreamRoute(ai));
app.route("/api/config/presets", createPresetsRoute(ai));
app.route("/api/kernel/turn", createTurnRoute(kernelStack.kernel));
app.route("/api/plugins", createPluginsRoute(kernelStack.pluginHost));

export { app };
