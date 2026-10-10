import { Hono } from "hono";
import { serverSettingsWritable } from "@covel/shared";
import { errorBody, readJsonBody } from "../../api-error.js";
import {
  ServerSettingsValidationError,
  type ServerSettings,
} from "../../lib/server-settings.js";
import { makeDesktopRestTokenGuard } from "../privileged-auth.js";

/**
 * `/api/config/server-settings`: the settings the server itself acts on.
 *
 * GET answers on every tier and holds no secret: the value in force of each
 * registered key, where it comes from, and whether a write would count. The
 * Settings page uses it to show a locked control where the player cannot
 * choose.
 *
 * PUT is for `DEPLOYMENT_TIER=self` only, where the one player owns the
 * server; it also requires the desktop token when the shell set one. On a
 * hosted tier these settings are the operator's and come from the
 * environment, so the write is refused whatever the caller presents.
 */
export function createServerSettingsRoutes(settings: ServerSettings): Hono {
  const app = new Hono();
  const requireToken = makeDesktopRestTokenGuard();

  app.get("/", async (c) => {
    // Another process may have written since the cache was filled.
    await settings.load();
    return c.json(settings.describe());
  });

  app.put(
    "/",
    async (c, next) => {
      if (serverSettingsWritable()) return next();
      return c.json(
        errorBody("Server settings are set by the operator of this server", {
          code: "server_settings_operator_only",
        }),
        403,
      );
    },
    requireToken,
    async (c) => {
      const parsed = await readJsonBody(c);
      if (parsed instanceof Response) return parsed;
      await settings.load();
      let patch;
      try {
        patch = settings.parsePatch(parsed.body);
      } catch (error) {
        if (!(error instanceof ServerSettingsValidationError)) throw error;
        return c.json(
          errorBody(error.message, {
            code: error.code,
            ...(error.key ? { details: { key: error.key } } : {}),
          }),
          error.code === "server_setting_fixed" ? 409 : 400,
        );
      }
      await settings.write(patch);
      return c.json(settings.describe());
    },
  );

  return app;
}
