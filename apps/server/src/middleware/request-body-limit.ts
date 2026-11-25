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

const BROWSER_CHECKPOINT_PATH_RE =
  /^\/api\/sessions\/[^/]+\/browser-checkpoint$/;

export function bodyLimitForRequest(method: string, path: string): number {
  if (method === "PUT" && BROWSER_CHECKPOINT_PATH_RE.test(path)) {
    return BROWSER_CHECKPOINT_BODY_LIMIT_BYTES;
  }
  if (
    path === "/api/install" ||
    path.startsWith("/api/install/") ||
    path === "/api/media"
  ) {
    return INSTALL_BODY_LIMIT_BYTES;
  }
  return DEFAULT_BODY_LIMIT_BYTES;
}

export function createRequestBodyLimitMiddleware(): MiddlewareHandler {
  return (c, next) => {
    const limit = bodyLimitForRequest(c.req.method, c.req.path);
    if (limit === BROWSER_CHECKPOINT_BODY_LIMIT_BYTES) {
      // Full browser checkpoints include the complete message and snapshot
      // history, so they need a separate bounded budget as sessions grow.
      return browserCheckpointBodyLimit(c, next);
    }
    if (limit === INSTALL_BODY_LIMIT_BYTES) {
      // Plugin/world installs and player image uploads (POST /api/media).
      // GET /api/media/:id has no body, so the wider cap there is harmless.
      return installBodyLimit(c, next);
    }
    return defaultBodyLimit(c, next);
  };
}
