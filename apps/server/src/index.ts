// Side-effect import — must come before `./app.js` so the env mutation lands
// before app.ts captures `readRuntimeEnv()` at module init. ESM evaluates
// imports in dependency order, and dev-home-bootstrap has no dependencies on
// app, so its top-level call fires first.
import "./dev-home-bootstrap.js";
import { serve } from "@hono/node-server";
import { readRuntimeEnv } from "@covel/shared";
import { app, drainServerResources } from "./app.js";
import { registerGracefulShutdown } from "./graceful-shutdown.js";
import { isOwnerAuthEnforced } from "./routes/api/session/session-guard.js";

const env = readRuntimeEnv();
const { serverPort: port, bindHost } = env;

console.log(`Starting server on ${bindHost}:${port}...`);

// Loopback is the only network boundary on tiers where session owner tokens
// are not enforced. A public bind there means anyone who can reach the port
// can drive sessions and spend configured LLM keys. Warn loudly rather than
// refuse: container/self-host deploys that terminate auth upstream legitimately
// bind 0.0.0.0 while keeping the default tier.
const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);
const sessionAuthEnforced =
  isOwnerAuthEnforced(env.deploymentTier) ||
  (env.nodeEnv === "production" && env.storeBackend === "memory");
if (!LOOPBACK_BINDS.has(bindHost) && !sessionAuthEnforced) {
  console.warn(
    `[security] Listening on ${bindHost} with DEPLOYMENT_TIER=${env.deploymentTier ?? "self"}: ` +
      "session and plugin APIs are UNAUTHENTICATED. Anyone who can reach this port " +
      "can control sessions and spend configured provider keys. Keep " +
      "COVEL_BIND_HOST=127.0.0.1, or set DEPLOYMENT_TIER=demo|commercial with " +
      "COVEL_DESKTOP_REST_TOKEN to enforce owner tokens.",
  );
}

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
