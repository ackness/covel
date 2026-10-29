import type { MiddlewareHandler } from "hono";
import { errorBody } from "../api-error.js";

const EMBEDDED_DESTINATIONS = new Set(["iframe", "frame", "embed", "object"]);

/** Opaque plugin documents and embedded navigations cannot address the API. */
export function createForeignRequestGuardMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path !== "/api" && !c.req.path.startsWith("/api/")) return next();
    if (
      c.req.header("origin")?.trim().toLowerCase() === "null" ||
      EMBEDDED_DESTINATIONS.has(c.req.header("sec-fetch-dest") ?? "")
    )
      return c.json(
        errorBody("Request from an embedded or opaque page refused", {
          code: "foreign_request_refused",
        }),
        403,
      );
    return next();
  };
}
