// Side-effect import — must come before `./app.js` so the env mutation lands
// before app.ts captures `readRuntimeEnv()` at module init. ESM evaluates
// imports in dependency order, and dev-home-bootstrap has no dependencies on
// app, so its top-level call fires first.
import "./dev-home-bootstrap.js";
import { serve } from "@hono/node-server";
import { readRuntimeEnv } from "@covel/shared";
import { app, drainServerResources, hostProfile } from "./app.js";
import { registerGracefulShutdown } from "./graceful-shutdown.js";
import { bindWarnings } from "./host-profile.js";

const env = readRuntimeEnv();
const { serverPort: port, bindHost } = env;

console.log(`Starting server on ${bindHost}:${port}...`);

// Loopback is the only network boundary where the host profile asks for no
// session token. Warn loudly rather than refuse on a public bind:
// container/self-host deploys that terminate auth upstream legitimately bind
// 0.0.0.0 while keeping the default tier.
for (const warning of bindWarnings(hostProfile, bindHost)) {
  console.warn(warning);
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
    if (process.connected && process.send) {
      process.send({ type: "covel:ready", port: info.port }, (error) => {
        if (error) console.warn("[desktop] Readiness IPC failed:", error);
      });
    }
  },
);

registerGracefulShutdown(server, { drain: drainServerResources });
