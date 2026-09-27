import { Hono } from "hono";
import { z } from "zod";
import { readRuntimeEnv } from "@covel/shared";
import type { BootstrapPluginEntries } from "./bootstrap/plugin-entry.js";
import { errorBody, okBody } from "../../api-error.js";
import { makeInstallApiGuard } from "../privileged-auth.js";

/** Community development reload never becomes a production or builtin write path. */
export function createPluginReloadRoutes(
  entries: BootstrapPluginEntries,
  development = readRuntimeEnv().nodeEnv === "development",
) {
  const routes = new Hono();
  routes.post("/:id/reload", makeInstallApiGuard(), async (c) => {
    if (!development)
      return c.json(
        errorBody("Plugin reload is disabled", {
          code: "plugin_reload_disabled",
        }),
        403,
      );
    const pluginId = c.req.param("id");
    if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(pluginId))
      return c.json(errorBody("Invalid plugin id"), 400);
    let input: unknown;
    try {
      const text = await c.req.text();
      input = text.trim() ? JSON.parse(text) : {};
    } catch {
      return c.json(errorBody("Invalid reload request"), 400);
    }
    const body = z
      .object({ sessionId: z.string().min(1).optional() })
      .strict()
      .safeParse(input);
    if (!body.success) return c.json(errorBody("Invalid reload request"), 400);
    try {
      return c.json(
        okBody(await entries.reload(pluginId, body.data.sessionId)),
      );
    } catch (error) {
      console.warn("[plugin-entry] reload rejected", { pluginId, error });
      return c.json(
        errorBody("Plugin reload failed; the previous generation is retained", {
          code: "plugin_reload_failed",
        }),
        409,
      );
    }
  });
  return routes;
}
