import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { healthRoute } from "./routes/health.js";

const app = new Hono();

app.use("*", logger());
app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:5173"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  }),
);

app.route("/api/health", healthRoute);

export { app };
