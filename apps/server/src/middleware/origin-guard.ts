import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { readRuntimeEnv } from "@covel/shared";
import { errorBody } from "../api-error.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function normalizeIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("::ffff:")) return trimmed.slice("::ffff:".length);
  return trimmed;
}

function parseTrustedProxyIps(raw: string | undefined): ReadonlySet<string> {
  const ips = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const normalized = normalizeIp(part);
    if (normalized) ips.add(normalized);
  }
  return ips;
}

function requestRemoteAddr(c: Context): string | undefined {
  try {
    return normalizeIp(getConnInfo(c).remote.address);
  } catch {
    return undefined;
  }
}

function parseOriginHeader(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    if (url.pathname !== "/" || value.endsWith("/")) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function parseRequestUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function forwardedOrigin(c: Context, requestUrl: URL): string | undefined {
  const rawHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const rawProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  if (!rawHost && !rawProto) return undefined;

  let proto: string;
  if (rawProto) {
    const lower = rawProto.toLowerCase();
    if (lower !== "http" && lower !== "https") return undefined;
    proto = `${lower}:`;
  } else {
    proto = requestUrl.protocol;
  }

  const host = rawHost || requestUrl.host;
  if (!host || /[\s/?#@\\]/.test(host)) return undefined;
  try {
    const candidate = new URL(`${proto}//${host}`);
    if (
      candidate.protocol !== proto ||
      candidate.username ||
      candidate.password ||
      candidate.pathname !== "/" ||
      candidate.search ||
      candidate.hash
    ) {
      return undefined;
    }
    return candidate.origin;
  } catch {
    return undefined;
  }
}

function expectedRequestOrigin(c: Context): string | undefined {
  const requestUrl = parseRequestUrl(c.req.url);
  if (!requestUrl) return undefined;

  const remote = requestRemoteAddr(c);
  const trustedProxyIps = parseTrustedProxyIps(
    readRuntimeEnv().trustedProxyIps,
  );
  const canTrustForwarded = remote !== undefined && trustedProxyIps.has(remote);
  const hasForwarded =
    c.req.header("x-forwarded-host") !== undefined ||
    c.req.header("x-forwarded-proto") !== undefined;

  if (canTrustForwarded && hasForwarded) {
    return forwardedOrigin(c, requestUrl);
  }
  return requestUrl.origin;
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
 * CORS allowlist, and an origin whose full scheme + host matches this request's
 * own origin (or the forwarded scheme + host from a configured trusted proxy).
 */
export function createOriginGuardMiddleware(
  isAllowedOrigin: (origin: string) => boolean,
): MiddlewareHandler {
  return async (c, next) => {
    if (!WRITE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header("origin");
    if (origin === undefined || isAllowedOrigin(origin)) return next();
    const parsedOrigin = parseOriginHeader(origin);
    const expected = expectedRequestOrigin(c);
    if (
      parsedOrigin !== undefined &&
      expected !== undefined &&
      parsedOrigin === expected
    ) {
      return next();
    }
    return c.json(
      errorBody("Cross-origin request refused", {
        code: "origin_not_allowed",
      }),
      403,
    );
  };
}
