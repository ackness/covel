import { createMiddleware } from "hono/factory";

// ── Configuration (from environment variables) ──────────────────────

interface RateLimitConfig {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly aiMaxRequests: number;
}

function loadConfig(): RateLimitConfig {
  return {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? "100", 10),
    aiMaxRequests: parseInt(process.env.RATE_LIMIT_AI_MAX ?? "20", 10),
  };
}

// ── Sliding window counter store ────────────────────────────────────

interface RequestRecord {
  readonly timestamp: number;
}

/**
 * In-memory sliding window store.
 *
 * Keys are `${ip}:${routePrefix}`. Each key holds an array of
 * timestamps representing requests within the current window.
 */
class SlidingWindowStore {
  private readonly records = new Map<string, RequestRecord[]>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly windowMs: number) {}

  /**
   * Record a request and return the current count within the window.
   */
  hit(key: string, now: number): number {
    const windowStart = now - this.windowMs;
    const existing = this.records.get(key);

    // Filter to only records within the current window, then append the new one
    const filtered = existing
      ? existing.filter((r) => r.timestamp > windowStart)
      : [];
    const updated = [...filtered, { timestamp: now }];

    this.records.set(key, updated);
    return updated.length;
  }

  /**
   * Get the count of requests within the current window (without recording).
   */
  count(key: string, now: number): number {
    const windowStart = now - this.windowMs;
    const existing = this.records.get(key);
    if (!existing) return 0;
    return existing.filter((r) => r.timestamp > windowStart).length;
  }

  /**
   * Remove expired entries from all keys. Called periodically to prevent
   * memory leaks from stale client entries.
   */
  cleanup(now: number): void {
    const windowStart = now - this.windowMs;
    const keysToDelete: string[] = [];

    for (const [key, records] of this.records) {
      const active = records.filter((r) => r.timestamp > windowStart);
      if (active.length === 0) {
        keysToDelete.push(key);
      } else {
        this.records.set(key, active);
      }
    }

    for (const key of keysToDelete) {
      this.records.delete(key);
    }
  }

  /**
   * Start periodic cleanup. Interval defaults to 2x the window size
   * to balance memory usage vs. CPU overhead.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    const interval = this.windowMs * 2;
    this.cleanupTimer = setInterval(() => {
      this.cleanup(Date.now());
    }, interval);
    // Allow the process to exit even if the timer is still running
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// ── Route prefix classification ─────────────────────────────────────

/**
 * Determine the route prefix bucket for rate limiting.
 * AI routes get a stricter limit; health routes are excluded.
 */
function classifyRoute(path: string): { prefix: string; isAi: boolean; isExcluded: boolean } {
  if (path === "/api/health" || path === "/health") {
    return { prefix: "health", isAi: false, isExcluded: true };
  }
  if (path.startsWith("/api/ai/") || path === "/api/ai") {
    return { prefix: "/api/ai", isAi: true, isExcluded: false };
  }
  if (path.startsWith("/api/")) {
    return { prefix: "/api", isAi: false, isExcluded: false };
  }
  return { prefix: "/", isAi: false, isExcluded: false };
}

/**
 * Extract client IP from the request, respecting common proxy headers.
 */
function getClientIp(req: { header: (name: string) => string | undefined }): string {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    // Take the first IP in the chain (original client)
    const first = forwarded.split(",")[0];
    return first ? first.trim() : "unknown";
  }
  return req.header("x-real-ip") ?? "unknown";
}

// ── Middleware factory ───────────────────────────────────────────────

/**
 * Create a rate limiter middleware for Hono.
 *
 * - Sliding window counter per IP + route prefix
 * - Configurable via environment variables
 * - AI routes (`/api/ai/*`) use a stricter limit
 * - Health check routes are excluded
 * - Adds standard rate limit response headers
 * - Periodic cleanup prevents memory leaks
 */
export function createRateLimiter() {
  const config = loadConfig();
  const store = new SlidingWindowStore(config.windowMs);
  store.startCleanup();

  return createMiddleware(async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const route = classifyRoute(path);

    // Skip rate limiting for excluded routes (health checks)
    if (route.isExcluded) {
      await next();
      return;
    }

    const ip = getClientIp(c.req);
    const key = `${ip}:${route.prefix}`;
    const now = Date.now();
    const limit = route.isAi ? config.aiMaxRequests : config.maxRequests;

    // Check current count before recording
    const currentCount = store.count(key, now);

    if (currentCount >= limit) {
      const retryAfterSec = Math.ceil(config.windowMs / 1000);
      c.header("Retry-After", String(retryAfterSec));
      c.header("X-RateLimit-Limit", String(limit));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", String(Math.ceil((now + config.windowMs) / 1000)));
      return c.json({ error: "Too Many Requests" }, 429);
    }

    // Record the request
    const count = store.hit(key, now);
    const remaining = Math.max(0, limit - count);

    // Set rate limit headers on all responses
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil((now + config.windowMs) / 1000)));

    await next();
  });
}

// Export for testing
export { SlidingWindowStore, classifyRoute, getClientIp, loadConfig };
export type { RateLimitConfig };
