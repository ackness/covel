import type { Stats } from "node:fs";
import type { Context } from "hono";

export function requestAbortSignal(c: Context): AbortSignal {
  const shutdownSignal = c.get("requestWork")?.signal;
  return shutdownSignal
    ? AbortSignal.any([c.req.raw.signal, shutdownSignal])
    : c.req.raw.signal;
}

export function prefixedConsoleLogger(tag: string) {
  return {
    info: (...args: unknown[]) => console.log(`[${tag}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${tag}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${tag}]`, ...args),
  };
}

/** Reject a replacement package even when its path and record dates match. */
export function sameFileIdentity(a: Stats | undefined, b: Stats): boolean {
  return Boolean(
    a && a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs,
  );
}
