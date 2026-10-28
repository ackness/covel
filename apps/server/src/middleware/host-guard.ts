import type { MiddlewareHandler } from "hono";
import { errorBody } from "../api-error.js";
import type { HostProfile } from "../host-profile.js";

/** Names that always reach the machine the server runs on. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;

/**
 * The host name in a `Host` header or a configured entry, lower-cased and
 * without its port (`[::1]:3001` → `[::1]`). Undefined when it does not parse.
 */
function hostnameOf(host: string): string | undefined {
  try {
    const url = new URL(`http://${host.trim()}`);
    return url.username || url.password || url.pathname !== "/"
      ? undefined
      : url.hostname;
  } catch {
    return undefined;
  }
}

/**
 * Refuse a request whose `Host` header names a host this server was not set
 * up to be reached by.
 *
 * On a personal host (the `self` tier's usual form: the desktop app, a
 * self-hosted web app and `pnpm dev`) the API takes no token: listening on
 * loopback is its only boundary. That limits who
 * can connect, not which name a browser uses. A page on `attacker.example`
 * can point its own name at 127.0.0.1 (DNS rebinding); the browser then
 * treats the local server as that page's own origin, so CORS and the origin
 * guard both let it through. A rebound request still carries the attacker's
 * name in `Host`, so the name is checked here, on every method.
 *
 * Allowed: the loopback names and the names an operator lists in
 * `COVEL_ALLOWED_HOSTS`. The port is not compared: rebinding changes the name,
 * not the port, and the Vite dev proxy forwards its own port. A request with
 * no `Host` header comes from no browser and passes. The host profile turns
 * the check off on the shared forms (browser-private, `demo`, `commercial`),
 * which authenticate requests instead (`network.checkHost`).
 */
export function createHostGuardMiddleware(
  network: HostProfile["network"],
): MiddlewareHandler {
  if (!network.checkHost) return (_c, next) => next();
  const allowed = new Set<string>(LOOPBACK_HOSTS);
  for (const entry of network.allowedHosts) {
    const name = hostnameOf(entry);
    if (name) allowed.add(name);
  }
  return async (c, next) => {
    const host = c.req.header("host");
    if (host === undefined) return next();
    const name = hostnameOf(host);
    if (name !== undefined && allowed.has(name)) return next();
    return c.json(
      errorBody(
        `This server does not answer to the host name "${host}". ` +
          "Open it at localhost, or add the name to COVEL_ALLOWED_HOSTS.",
        { code: "host_not_allowed" },
      ),
      403,
    );
  };
}
