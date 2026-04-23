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
