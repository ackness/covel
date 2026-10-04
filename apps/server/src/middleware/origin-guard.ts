import type { MiddlewareHandler } from "hono";
import { errorBody } from "../api-error.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hostOf(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

/**
 * Refuse a state-changing request that a browser sent from another site.
 *
 * CORS only keeps a page from reading the response. A "simple" cross-site
 * request (a form post, or `fetch` with `text/plain`) needs no preflight, so
 * its handler runs and its writes land whatever CORS answers. Browsers attach
 * `Origin` to every cross-site request and to every same-site write, so the
 * check is made here, before any route.
 *
 * Allowed: a request without `Origin` (a non-browser client), an origin on the
 * CORS allowlist, and an origin whose host is the host this request was sent
 * to — the page the server itself serves, directly or through a proxy.
 */
export function createOriginGuardMiddleware(
  isAllowedOrigin: (origin: string) => boolean,
): MiddlewareHandler {
  return async (c, next) => {
    if (!WRITE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header("origin");
    if (origin === undefined || isAllowedOrigin(origin)) return next();
    const originHost = hostOf(origin);
    const sameHost =
      originHost !== undefined &&
      (originHost === hostOf(c.req.url) ||
        originHost === c.req.header("x-forwarded-host"));
    if (sameHost) return next();
    return c.json(
      errorBody("Cross-origin request refused", {
        code: "origin_not_allowed",
      }),
      403,
    );
  };
}
