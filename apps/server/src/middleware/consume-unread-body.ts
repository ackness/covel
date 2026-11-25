import type { MiddlewareHandler } from "hono";
import { bodyLimitForRequest } from "./request-body-limit.js";

/**
 * Read and discard a request body the route answered without reading, before
 * the response goes out.
 *
 * A route that rejects early (401 for a shared world, 403, 404, 429) leaves
 * the body unread. @hono/node-server then drains it after the response, but
 * that drain stalls after 64 KiB and destroys the socket 500 ms later. The
 * browser has by then reused the keep-alive connection for its next request,
 * so an SSE stream (model relay, session events) or a code chunk is cut off
 * mid-transfer. Draining the stream in O(1) memory keeps the connection usable
 * without buffering large bodies into RAM.
 *
 * Bodies larger than the route's own limit, and 413 answers, are left alone:
 * the connection may close instead of the server reading them.
 */
async function drainBodyBounded(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<void> {
  const reader = body.getReader();
  let drained = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      drained += value.byteLength;
      if (drained > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  } catch {
    // Ignore client disconnects or aborted streams during best-effort drain.
  } finally {
    reader.releaseLock();
  }
}

export function createConsumeUnreadBodyMiddleware(
  maxBytes?: number,
): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const request = c.req.raw;
    if (!request.body || request.bodyUsed || c.res.status === 413) return;
    const effectiveMaxBytes =
      maxBytes ?? bodyLimitForRequest(c.req.method, c.req.path);
    const length = Number(c.req.header("content-length"));
    if (!Number.isFinite(length) || length < 0 || length > effectiveMaxBytes) {
      return;
    }
    await drainBodyBounded(request.body, effectiveMaxBytes);
  };
}
