import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BROWSER_CHECKPOINT_MAX_BYTES } from "@covel/store/browser-sync";
import { errorBody } from "../api-error.js";

export const DEFAULT_BODY_LIMIT_BYTES = 1 * 1024 * 1024;
export const INSTALL_BODY_LIMIT_BYTES = 20 * 1024 * 1024;
export const BROWSER_CHECKPOINT_BODY_LIMIT_BYTES = BROWSER_CHECKPOINT_MAX_BYTES;

const onBodyTooLarge = (c: Context) =>
  c.json(errorBody("Payload Too Large"), 413);
const defaultBodyLimit = bodyLimit({
  maxSize: DEFAULT_BODY_LIMIT_BYTES,
  onError: onBodyTooLarge,
});
const installBodyLimit = bodyLimit({
  maxSize: INSTALL_BODY_LIMIT_BYTES,
  onError: onBodyTooLarge,
});
const browserCheckpointBodyLimit = bodyLimit({
  maxSize: BROWSER_CHECKPOINT_BODY_LIMIT_BYTES,
  onError: onBodyTooLarge,
});

export function createRequestBodyLimitMiddleware(): MiddlewareHandler {
  return (c, next) => {
    if (
      c.req.method === "PUT" &&
      /^\/api\/sessions\/[^/]+\/browser-checkpoint$/.test(c.req.path)
    ) {
      // Full browser checkpoints include the complete message and snapshot
      // history, so they need a separate bounded budget as sessions grow.
      return browserCheckpointBodyLimit(c, next);
    }
    if (
      c.req.path === "/api/install" ||
      c.req.path.startsWith("/api/install/") ||
      // Player image uploads (POST /api/media) — content-addressed portraits
      // are a few MB. GET /api/media/:id has no body, so the wider cap there
      // is harmless.
      c.req.path === "/api/media"
    ) {
      return installBodyLimit(c, next);
    }
    return defaultBodyLimit(c, next);
  };
}
