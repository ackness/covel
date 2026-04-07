import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { registerGracefulShutdown } from "./graceful-shutdown.js";

const port = Number(process.env.SERVER_PORT) || 3001;

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
