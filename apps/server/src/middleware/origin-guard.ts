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

function buildOrigin(
  proto: "http:" | "https:",
  host: string,
): string | undefined {
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

function parseForwardedProto(c: Context): string | undefined {
  const xfp = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  if (xfp !== undefined && xfp.length > 0) return xfp.toLowerCase();

  const forwarded = c.req.header("forwarded")?.split(",")[0];
  if (!forwarded) return undefined;
  for (const part of forwarded.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== "proto") continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).trim();
    }
    if (value.length > 0) return value.toLowerCase();
  }
  return undefined;
}

function forwardedOrigin(
  rawHost: string | undefined,
  rawProto: string | undefined,
  requestUrl: URL,
): string | undefined {
  if (!rawHost && !rawProto) return undefined;

  let proto: "http:" | "https:";
  if (rawProto !== undefined) {
    if (rawProto !== "http" && rawProto !== "https") return undefined;
    proto = `${rawProto}:`;
  } else {
    proto = requestUrl.protocol as "http:" | "https:";
  }

  return buildOrigin(proto, rawHost || requestUrl.host);
}

function expectedRequestOrigin(c: Context): string | undefined {
  const requestUrl = parseRequestUrl(c.req.url);
  if (!requestUrl) return undefined;

  const rawForwardedHost = c.req
    .header("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const rawForwardedProto = parseForwardedProto(c);
  const hasForwarded =
    (rawForwardedHost !== undefined && rawForwardedHost.length > 0) ||
    rawForwardedProto !== undefined;

  const remote = requestRemoteAddr(c);
  const trustedProxyIps = parseTrustedProxyIps(
    readRuntimeEnv().trustedProxyIps,
  );
  const canTrustForwarded = remote !== undefined && trustedProxyIps.has(remote);

  if (canTrustForwarded && hasForwarded) {
    return forwardedOrigin(rawForwardedHost, rawForwardedProto, requestUrl);
  }

  // Behind TLS-terminating reverse proxies (such as Render, Fly.io, or
  // managed load balancers whose proxy IPs are dynamic and cannot be listed in
  // TRUSTED_PROXY_IPS), the Node server sees plain HTTP with the public Host
  // header and X-Forwarded-Proto: https (or Forwarded: proto=https). Keep
  // X-Forwarded-Host gated behind TRUSTED_PROXY_IPS and never downgrade an
  // https: request; only upgrade an http: request's expected scheme to https:
  // on the same Host so same-site HTTPS writes succeed while cross-site writes
  // and http->https downgrades remain refused.
  if (requestUrl.protocol === "http:" && rawForwardedProto === "https") {
    return buildOrigin("https:", requestUrl.host);
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
 * own origin (upgraded to `https:` on the same `Host` when a TLS-terminating
 * proxy signals `https`, or using forwarded host + scheme from a configured
 * trusted proxy).
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
