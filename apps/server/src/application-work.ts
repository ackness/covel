import type { Context, MiddlewareHandler } from "hono";
import { setMaxListeners } from "node:events";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { errorBody } from "./api-error.js";

export interface RequestWork {
  /** Host shutdown only; disconnecting a client does not cancel its turn. */
  readonly signal: AbortSignal;
  /** Keep admitted child work owned through its complete asynchronous cleanup. */
  track<T>(run: () => Promise<T>): Promise<T>;
}

export interface ApplicationWork {
  readonly middleware: MiddlewareHandler;
  /** Stop admission, signal cancellation, and await admitted handlers and children. */
  close(): Promise<void>;
}

/** Own application work independently of response creation and socket lifetime. */
export function createApplicationWork(): ApplicationWork {
  const controller = new AbortController();
  // Concurrent streams intentionally share one host signal and remove their
  // listeners when their callbacks finish; the default limit of ten is too low.
  setMaxListeners(0, controller.signal);
  const owned = new Set<Promise<void>>();
  const contexts = new WeakSet<Context>();
  let closing: Promise<void> | undefined;

  return {
    middleware: async (c, next) => {
      // The composition root and embedded API can share this owner.
      if (contexts.has(c)) return next();
      if (closing) {
        return c.json(
          errorBody("Server is shutting down", {
            code: "server_shutting_down",
          }),
          503,
        );
      }
      let complete!: () => void;
      const completion = new Promise<void>((resolve) => {
        complete = resolve;
      });
      let pending = 1;
      const release = () => {
        if (--pending === 0) {
          owned.delete(completion);
          complete();
        }
      };
      owned.add(completion);
      contexts.add(c);
      c.set("requestWork", {
        signal: controller.signal,
        async track<T>(run: () => Promise<T>): Promise<T> {
          if (pending === 0)
            throw new Error("Request work is already complete");
          pending++;
          try {
            return await run();
          } finally {
            release();
          }
        },
      });
      try {
        await next();
      } finally {
        contexts.delete(c);
        release();
      }
    },
    close() {
      if (closing) return closing;
      // Publish before abort listeners can re-enter close(). Each owned promise
      // includes children started by its still-running request after this call.
      closing = Promise.resolve().then(async () => {
        await Promise.all(owned);
      });
      controller.abort(
        new DOMException("Server is shutting down", "AbortError"),
      );
      return closing;
    },
  };
}

/** Also works with deliberately minimal route fixtures that omit host ownership. */
export function trackRequestWork<T>(
  c: Context,
  run: () => Promise<T>,
): Promise<T> {
  const work = c.get("requestWork");
  return work ? work.track(run) : run();
}

/** Hono returns the Response before this callback settles; own the callback itself. */
export function streamOwnedSSE(
  c: Context,
  run: (stream: SSEStreamingApi) => Promise<void>,
): Response {
  return streamSSE(c, (stream) =>
    trackRequestWork(c, async () => {
      const signal = c.get("requestWork")?.signal;
      const abort = () => stream.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        await run(stream);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    }),
  );
}
