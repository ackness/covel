/**
 * Simple in-memory rate limiter middleware for Hono.
 *
 * Uses a sliding window per IP. Not suitable for multi-process deployments
 * (use Redis-backed limiter for T3). Sufficient for T1/T2.
 */

import type { MiddlewareHandler } from 'hono';
import { readRuntimeEnv } from '@covel/shared';

interface RateLimitOptions {
  /** Maximum requests per window. Default: 60 */
  max?: number;
  /** Window size in milliseconds. Default: 60_000 (1 minute) */
  windowMs?: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

export function rateLimiter(opts: RateLimitOptions = {}): MiddlewareHandler {
  const max = opts.max ?? readRuntimeEnv().rateLimitRpm;
  const windowMs = opts.windowMs ?? 60_000;
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

    const ip = c.req.header('x-forwarded-for')
      ?? c.req.header('x-real-ip')
      ?? 'unknown';

    const key = `${ip}:${c.req.path}`;
    const entry = windows.get(key);

    if (!entry || now >= entry.resetAt) {
      windows.set(key, { count: 1, resetAt: now + windowMs });
      await next();
      return;
    }

    if (entry.count >= max) {
      c.header('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: 'Too many requests' }, 429);
    }

    entry.count++;
    await next();
  };
}

/**
 * Single-flight guard — allows only one concurrent execution per key.
 * Useful for expensive operations like model-db refresh.
 */
export function singleFlight(keyFn: (c: { req: { path: string } }) => string = (c) => c.req.path): MiddlewareHandler {
  const inflight = new Set<string>();

  return async (c, next) => {
    const key = keyFn(c);
    if (inflight.has(key)) {
      return c.json({ error: 'Operation already in progress' }, 429);
    }

    inflight.add(key);
    try {
      await next();
    } finally {
      inflight.delete(key);
    }
  };
}
