import type { MiddlewareHandler } from "hono";
import { BROWSER_CHECKPOINT_BODY_LIMIT_BYTES } from "./request-body-limit.js";

/**
 * Read and discard a request body the route answered without reading, before
 * the response goes out.
 *
 * A route that rejects early (401 for a shared world, 403, 404, 429) leaves
 * the body unread. @hono/node-server then drains it after the response, but
 * that drain stalls after 64 KiB and destroys the socket 500 ms later. The
 * browser has by then reused the keep-alive connection for its next request,
 * so an SSE stream (model relay, session events) or a code chunk is cut off
 * mid-transfer. Reading the body here keeps the connection usable.
 *
 * Bodies larger than any route accepts, and 413 answers, are left alone: the
 * connection may close instead of the server reading them.
 */
export function createConsumeUnreadBodyMiddleware(
  maxBytes = BROWSER_CHECKPOINT_BODY_LIMIT_BYTES,
): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const request = c.req.raw;
    if (!request.body || request.bodyUsed || c.res.status === 413) return;
    const length = Number(c.req.header("content-length"));
    if (!Number.isFinite(length) || length > maxBytes) return;
    await request.arrayBuffer().catch(() => undefined);
  };
}
