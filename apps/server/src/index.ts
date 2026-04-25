// Side-effect import — must come before `./app.js` so the env mutation lands
// before app.ts captures `readRuntimeEnv()` at module init. ESM evaluates
// imports in dependency order, and dev-home-bootstrap has no dependencies on
// app, so its top-level call fires first.
import "./dev-home-bootstrap.js";
import { serve } from "@hono/node-server";
import { readRuntimeEnv } from "@covel/shared";
import { app } from "./app.js";
import { registerGracefulShutdown } from "./graceful-shutdown.js";

const port = readRuntimeEnv().serverPort;

console.log(`Starting server on port ${port}...`);

const server = serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`Server running at http://localhost:${info.port}`);
  },
);

registerGracefulShutdown(server);
