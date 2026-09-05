import type { Hono } from "hono";
import type { MediaStore } from "@covel/store";
import { errorBody } from "../../../api-error.js";
import { signMediaTokenForSession } from "../../../middleware/media-token.js";
import {
  isSessionOwnerAuthEnforced,
  resolveSessionParam,
} from "./session-guard.js";
import type { SessionRouteEnv } from "./route-env.js";

export function registerSessionMediaTokenRoute(
  routes: Hono<SessionRouteEnv>,
): void {
  routes.get("/:id/media-token", async (c) => {
    const sessionId = c.req.param("id");
    if (isSessionOwnerAuthEnforced(c)) {
      const guard = await resolveSessionParam(c);
      if (!guard.ok) return guard.response;
    }
    const mediaId = c.req.query("id");
    if (!mediaId) {
      return c.json(
        errorBody("id query parameter is required", {
          code: "invalid_request",
        }),
        400,
      );
    }

    const mediaStore = c.get("mediaStore");
    if (!mediaStore) {
      return c.json(
        errorBody("Media store unavailable", {
          code: "media_store_unavailable",
        }),
        503,
      );
    }

    let lookup: Awaited<ReturnType<MediaStore["lookup"]>>;
    try {
      lookup = await mediaStore.lookup(mediaId);
    } catch (error) {
      console.error("[sessions/media-token] MediaStore.lookup failed:", error);
      return c.json(
        errorBody("Failed to load media metadata", {
          code: "media_lookup_failed",
        }),
        500,
      );
    }
    if (!lookup) {
      return c.json(
        errorBody("Media not found", { code: "media_not_found" }),
        404,
      );
    }

    let allowed = lookup.ownerSessionId === sessionId;
    if (!allowed) {
      try {
        allowed = await mediaStore.isReferencedBy(mediaId, sessionId);
      } catch (error) {
        console.error(
          "[sessions/media-token] MediaStore.isReferencedBy failed:",
          error,
        );
        return c.json(
          errorBody("Failed to check media access", {
            code: "media_access_check_failed",
          }),
          500,
        );
      }
    }
    if (!allowed) {
      return c.json(errorBody("Forbidden", { code: "media_forbidden" }), 403);
    }

    const token = signMediaTokenForSession(mediaId, sessionId);
    return c.json({
      url: `/api/media/${encodeURIComponent(mediaId)}?token=${encodeURIComponent(token)}`,
    });
  });
}
