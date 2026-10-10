/**
 * Simple in-memory rate limiter middleware for Hono.
 *
 * Uses a sliding window per IP. Not suitable for multi-process deployments
 * (use Redis-backed limiter for T3). Sufficient for T1/T2.
 */

import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { readRuntimeEnv } from "@covel/shared";
import { errorBody } from "../api-error.js";

interface RateLimitOptions {
  /** Maximum requests per window. */
  max: number;
  /** Cap on tracked (IP, route) counters; the oldest are evicted beyond it. */
  maxEntries?: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

/** Sliding-window size — every caller uses the same 1-minute window. */
const WINDOW_MS = 60_000;

const DEFAULT_MAX_ENTRIES = 10_000;

function parseTrustedProxyIps(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function normalizeIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("::ffff:")) return trimmed.slice("::ffff:".length);
  return trimmed;
}

function requestRemoteAddr(c: Context): string | undefined {
  // @hono/node-server does NOT attach the client address to the raw Request;
  // it is only exposed via getConnInfo (reads the underlying socket). Reading
  // `c.req.raw.connInfo` returned undefined for every request, collapsing the
  // limiter to a single global bucket. getConnInfo throws when there is no
  // socket (e.g. app.request() in tests) — fall back to undefined there.
  try {
    return normalizeIp(getConnInfo(c).remote.address);
  } catch {
    return undefined;
  }
}

function clientIp(c: Context): string {
  const env = readRuntimeEnv();
  const remote = requestRemoteAddr(c);
  const trustedProxyIps = parseTrustedProxyIps(env.trustedProxyIps);
  const canTrustForwarded = !!remote && trustedProxyIps.has(remote);

  if (canTrustForwarded) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0];
    return (
      normalizeIp(forwarded) ??
      normalizeIp(c.req.header("x-real-ip")) ??
      remote ??
      "unknown"
    );
  }

  return remote ?? "unknown";
}

export function rateLimiter({
  max,
  maxEntries = DEFAULT_MAX_ENTRIES,
}: RateLimitOptions): MiddlewareHandler {
  const windows = new Map<string, WindowEntry>();

  // Periodic cleanup to prevent memory leak (every 5 minutes)
  const CLEANUP_INTERVAL = 5 * 60_000;
  let lastCleanup = Date.now();

  return async (c, next) => {
    const now = Date.now();

    // Periodic cleanup of expired entries
    if (now - lastCleanup > CLEANUP_INTERVAL) {
      lastCleanup = now;
      for (const [key, entry] of windows) {
        if (now >= entry.resetAt) windows.delete(key);
      }
    }

    const ip = clientIp(c);
    // The route template, not the concrete path: a path parameter must not
    // open a fresh counter for every value a client tries.
    const key = `${ip}:${c.req.routePath}`;
    const entry = windows.get(key);

    if (!entry || now >= entry.resetAt) {
      // Re-insert so the map stays ordered by window start; the oldest
      // windows are the first to go when the table is full.
      windows.delete(key);
      // Oldest first: expired windows go, then live ones while over the cap.
      for (const [k, e] of windows) {
        if (now < e.resetAt && windows.size < maxEntries) break;
        windows.delete(k);
      }
      windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
      await next();
      return;
    }

    if (entry.count >= max) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json(
        errorBody("Too many requests", { code: "rate_limit_exceeded" }),
        429,
      );
    }

    entry.count++;
    await next();
  };
}

/** Per request: takes one more hold on the mark of its single-flight guard. */
const flightHolds = new WeakMap<Context, () => () => void>();

/**
 * Single-flight guard — allows only one concurrent execution per key.
 * Useful for expensive operations like model-db refresh.
 *
 * The mark is held while the handler runs. A handler that streams returns its
 * Response before its work ends, so the work takes its own hold with
 * {@link holdSingleFlight}; the mark goes when the last hold is released.
 */
export function singleFlight(): MiddlewareHandler {
  const inflight = new Set<string>();

  return async (c, next) => {
    const key = c.req.path;
    if (inflight.has(key)) {
      return c.json(
        errorBody("Operation already in progress", {
          code: "operation_in_progress",
        }),
        429,
      );
    }

    inflight.add(key);
    // The handler is the first hold.
    let holds = 1;
    const release = () => {
      if (--holds === 0) inflight.delete(key);
    };
    flightHolds.set(c, () => {
      // The mark is gone: another request may own the key by now.
      if (holds === 0) return () => {};
      holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
      };
    });
    try {
      await next();
    } finally {
      release();
    }
  };
}

/**
 * Keep the single-flight mark of this request until the returned function is
 * called. For work that outlives the handler, such as the callback of an SSE
 * stream: call this before the callback's first `await`, and release in its
 * `finally`. On a route without the guard the returned function does nothing.
 */
export function holdSingleFlight(c: Context): () => void {
  return flightHolds.get(c)?.() ?? (() => {});
}
