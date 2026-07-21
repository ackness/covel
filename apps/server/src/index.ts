// Side-effect import — must come before `./app.js` so the env mutation lands
// before app.ts captures `readRuntimeEnv()` at module init. ESM evaluates
// imports in dependency order, and dev-home-bootstrap has no dependencies on
// app, so its top-level call fires first.
import "./dev-home-bootstrap.js";
import { serve } from "@hono/node-server";
import { readRuntimeEnv } from "@covel/shared";
import { app, drainServerResources } from "./app.js";
import { registerGracefulShutdown } from "./graceful-shutdown.js";

const { serverPort: port, bindHost } = readRuntimeEnv();

console.log(`Starting server on ${bindHost}:${port}...`);

// Loopback by default: the API has no per-request auth on the
// self-deploy tier, so it must not listen on public interfaces unless the
// operator opts in explicitly (COVEL_BIND_HOST=0.0.0.0 — containers, hosted).
const server = serve(
  {
    fetch: app.fetch,
    port,
    hostname: bindHost,
  },
  (info) => {
    console.log(`Server running at http://${info.address}:${info.port}`);
  },
);

registerGracefulShutdown(server, { drain: drainServerResources });
