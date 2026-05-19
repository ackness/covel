import type { Context, MiddlewareHandler } from "hono";
import { readRuntimeEnv } from "@covel/shared";
import { apiError } from "../api-error.js";

function bearerToken(c: Context): string | undefined {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

/**
 * Per-launch bearer token gate for desktop-controlled filesystem APIs.
 */
export function makeDesktopRestTokenGuard(): MiddlewareHandler {
  return async (c: Context, next) => {
    const expected = readRuntimeEnv().desktopRestToken;
    if (!expected) return next();
    const provided = bearerToken(c);
    if (!provided || provided !== expected) {
      return c.json(
        apiError(
          "desktop_rest_token_invalid",
          "Desktop REST token missing or invalid",
        ),
        401,
      );
    }
    return next();
  };
}

/**
 * Install endpoints write plugin/world packages to local disk.
 *
 * Desktop sidecars use the same bearer token as config writes. Production
 * self-host deployments require either that token or an explicit operator
 * opt-in through COVEL_INSTALL_API_ENABLED=1.
 */
export function makeInstallApiGuard(): MiddlewareHandler {
  return async (c: Context, next) => {
    const env = readRuntimeEnv();
    if (env.desktopRestToken) {
      const provided = bearerToken(c);
      if (!provided || provided !== env.desktopRestToken) {
        return c.json(
          apiError(
            "desktop_rest_token_invalid",
            "Desktop REST token missing or invalid",
          ),
          401,
        );
      }
      return next();
    }

    if (env.nodeEnv === "production" && !env.installApiEnabled) {
      return c.json(
        apiError(
          "install_api_disabled",
          "Install API is disabled in production",
        ),
        403,
      );
    }

    return next();
  };
}
